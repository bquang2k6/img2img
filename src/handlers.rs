use std::sync::Arc;

use axum::extract::{FromRequest, Multipart, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::config::AppConfig;
use crate::filters::detect_filter_id;
use crate::logger::AppLogger;

pub struct AppState {
    pub config: AppConfig,
    pub http_client: reqwest::Client,
    pub logger: Arc<AppLogger>,
}

#[derive(Deserialize, Default)]
struct GeneratePayload {
    prompt: Option<String>,
    image_url: Option<String>,
    filter_id: Option<String>,
}

struct ParsedGenerateInput {
    prompt: Option<String>,
    image_url: Option<String>,
    filter_id: Option<String>,
    uploaded_image: Option<(String, Vec<u8>)>,
}

fn non_empty(opt: Option<String>) -> Option<String> {
    opt.filter(|s| !s.is_empty())
}

fn json_error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

pub async fn get_filters_data() -> Response {
    match tokio::fs::read("filters.json").await {
        Ok(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
            bytes,
        )
            .into_response(),
        Err(err) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Không thể đọc filters.json: {err}"),
        ),
    }
}

async fn parse_generate_request(
    req: Request,
    state: &Arc<AppState>,
) -> Result<ParsedGenerateInput, Response> {
    let content_type = req
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if content_type.starts_with("multipart/form-data") {
        let mut multipart = Multipart::from_request(req, state).await.map_err(|err| {
            json_error(StatusCode::BAD_REQUEST, format!("Lỗi multipart: {err}"))
        })?;

        let mut prompt = None;
        let mut image_url = None;
        let mut filter_id = None;
        let mut uploaded_image = None;

        while let Some(field) = multipart.next_field().await.map_err(|err| {
            json_error(StatusCode::BAD_REQUEST, format!("Lỗi đọc form: {err}"))
        })? {
            match field.name() {
                Some("image") => {
                    let mime = field
                        .content_type()
                        .map(str::to_string)
                        .unwrap_or_else(|| "image/jpeg".to_string());
                    let bytes = field.bytes().await.map_err(|err| {
                        json_error(StatusCode::BAD_REQUEST, format!("Lỗi đọc file ảnh: {err}"))
                    })?;
                    if !bytes.is_empty() {
                        uploaded_image = Some((mime, bytes.to_vec()));
                    }
                }
                Some("prompt") => {
                    prompt = field.text().await.ok();
                }
                Some("image_url") => {
                    image_url = field.text().await.ok();
                }
                Some("filter_id") => {
                    filter_id = field.text().await.ok();
                }
                _ => {}
            }
        }

        return Ok(ParsedGenerateInput {
            prompt: non_empty(prompt),
            image_url: non_empty(image_url),
            filter_id: non_empty(filter_id),
            uploaded_image,
        });
    }

    if content_type.starts_with("application/x-www-form-urlencoded") {
        let Form(payload) = Form::<GeneratePayload>::from_request(req, state)
            .await
            .map_err(|err| {
                json_error(StatusCode::BAD_REQUEST, format!("Lỗi form data: {err}"))
            })?;
        return Ok(ParsedGenerateInput {
            prompt: non_empty(payload.prompt),
            image_url: non_empty(payload.image_url),
            filter_id: non_empty(payload.filter_id),
            uploaded_image: None,
        });
    }

    let Json(payload) = Json::<GeneratePayload>::from_request(req, state)
        .await
        .map_err(|err| json_error(StatusCode::BAD_REQUEST, format!("Lỗi JSON: {err}")))?;

    Ok(ParsedGenerateInput {
        prompt: non_empty(payload.prompt),
        image_url: non_empty(payload.image_url),
        filter_id: non_empty(payload.filter_id),
        uploaded_image: None,
    })
}

async fn post_kira_generation(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    body: &Map<String, Value>,
) -> Result<(reqwest::StatusCode, Value), String> {
    let response = client
        .post(endpoint)
        .header("Content-Type", "application/json")
        .bearer_auth(api_key)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Phản hồi không phải JSON hợp lệ ({status}): {e}"))?;

    Ok((status, data))
}

pub async fn handle_generate(State(state): State<Arc<AppState>>, req: Request) -> Response {
    let input = match parse_generate_request(req, &state).await {
        Ok(parsed) => parsed,
        Err(err_resp) => return err_resp,
    };

    let Some(mut prompt) = input.prompt else {
        return json_error(StatusCode::BAD_REQUEST, "Yêu cầu phải có prompt");
    };

    let mut filter_id = input.filter_id;
    if filter_id.is_none() {
        match detect_filter_id(&prompt).await {
            Ok(detected) => filter_id = detected,
            Err(err) => {
                state
                    .logger
                    .error(&format!("Lỗi khi đọc filters.json: {err}"))
                    .await;
            }
        }
    }

    if let Some(ref fid) = filter_id {
        prompt = format!("{prompt} {fid}");
    }

    if !prompt.contains("1:1 aspect ratio") {
        prompt = format!(
            "Maintain a 1:1 aspect ratio, exact same zoom level, original camera distance, and perspective. Do not crop or change the object scale. {prompt}"
        );
    }

    state
        .logger
        .info("\n--------------------------------------------------")
        .await;
    state.logger.info("🎨 Nhận yêu cầu tạo ảnh mới...").await;
    if let Some(ref fid) = filter_id {
        state
            .logger
            .info(&format!("🎯 Đã nhận diện Filter ID: {fid}"))
            .await;
    }

    let Some(api_key) = state.config.valid_api_key() else {
        state
            .logger
            .error("❌ Chưa cấu hình KIRA_API_KEY hợp lệ trong file .env")
            .await;
        return json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Chưa cấu hình KIRA_API_KEY hợp lệ. Vui lòng thêm KIRA_API_KEY vào file .env",
        );
    };

    let input_image = if let Some((mime, bytes)) = input.uploaded_image {
        let encoded = BASE64_STANDARD.encode(&bytes);
        Some(format!("data:{mime};base64,{encoded}"))
    } else {
        input.image_url
    };

    state
        .logger
        .info(&format!(
            "⚡ Đang gửi yêu cầu tới Kira AI (Model: {})...",
            state.config.kira_model
        ))
        .await;

    let mut request_body = Map::new();
    request_body.insert("model".into(), json!(state.config.kira_model));
    request_body.insert("prompt".into(), json!(prompt));
    request_body.insert("n".into(), json!(1));
    request_body.insert("size".into(), json!("1024x1024"));

    if let Some(ref img) = input_image {
        request_body.insert("image".into(), json!(img));
        request_body.insert("image_url".into(), json!(img));
    }

    let endpoint = format!("{}/images/generations", state.config.kira_base_url);

    let (mut status, mut data) =
        match post_kira_generation(&state.http_client, &endpoint, api_key, &request_body).await {
            Ok(res) => res,
            Err(err) => {
                state
                    .logger
                    .error(&format!("❌ Lỗi máy chủ: {err}"))
                    .await;
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Lỗi xử lý: {err}"));
            }
        };

    // Nếu endpoint báo lỗi khi kèm trường image thì thử lại với prompt thuần
    let error_msg_opt = data
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str());

    if !status.is_success()
        && input_image.is_some()
        && let Some(err_msg) = error_msg_opt
        && (err_msg.contains("image") || status == reqwest::StatusCode::BAD_REQUEST)
    {
        state
            .logger
            .info("⚠️ Kira API không nhận kèm trường image trong body JSON, thử gửi lại với prompt thuần...")
            .await;
        request_body.remove("image");
        request_body.remove("image_url");

        match post_kira_generation(&state.http_client, &endpoint, api_key, &request_body).await {
            Ok((retry_status, retry_data)) => {
                status = retry_status;
                data = retry_data;
            }
            Err(err) => {
                state
                    .logger
                    .error(&format!("❌ Lỗi máy chủ: {err}"))
                    .await;
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, format!("Lỗi xử lý: {err}"));
            }
        }
    }

    if !status.is_success() {
        let err_msg = data
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .or_else(|| data.get("message").and_then(|m| m.as_str()))
            .map(str::to_string)
            .unwrap_or_else(|| format!("Lỗi API Kira ({})", status.as_u16()));

        state
            .logger
            .error(&format!("❌ Lỗi từ Kira AI: {err_msg}"))
            .await;

        let axum_status =
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        return json_error(axum_status, err_msg);
    }

    let first_item = data.get("data").and_then(|d| d.get(0));
    let output_url = first_item
        .and_then(|item| item.get("url").and_then(|u| u.as_str()).map(str::to_string))
        .or_else(|| {
            first_item
                .and_then(|item| item.get("b64_json").and_then(|b| b.as_str()))
                .map(|b64| format!("data:image/png;base64,{b64}"))
        });

    let Some(output_url) = output_url else {
        state
            .logger
            .error("❌ Không nhận được link ảnh từ phản hồi của Kira AI")
            .await;
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "Không tìm thấy dữ liệu ảnh trong phản hồi từ Kira AI",
                "raw": data
            })),
        )
            .into_response();
    };

    state
        .logger
        .info("✨ Đã tạo ảnh thành công từ Kira AI!")
        .await;

    (
        StatusCode::OK,
        Json(json!({
            "success": true,
            "output": output_url,
            "status": "completed"
        })),
    )
        .into_response()
}

