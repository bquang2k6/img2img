mod config;
mod filters;
mod handlers;
mod logger;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use socketioxide::SocketIo;
use socketioxide::extract::SocketRef;
use tower_http::cors::CorsLayer;

use crate::config::AppConfig;
use crate::handlers::{AppState, get_filters_data, handle_generate};
use crate::logger::AppLogger;

const MAX_BODY_SIZE: usize = 50 * 1024 * 1024;

#[tokio::main]
async fn main() {
    let config = AppConfig::from_env();
    let port = config.port;
    let kira_model = config.kira_model.clone();
    let kira_base_url = config.kira_base_url.clone();

    let (io_layer, io) = SocketIo::new_layer();

    io.ns("/", async |socket: SocketRef| {
        println!("🔗 Client connected to Socket.IO: {}", socket.id);

        socket.on_disconnect(async |s: SocketRef| {
            println!("🔗 Client disconnected: {}", s.id);
        });
    });

    let logger = Arc::new(AppLogger::new(io));
    let http_client = reqwest::Client::new();

    let state = Arc::new(AppState {
        config,
        http_client,
        logger: Arc::clone(&logger),
    });

    let app = Router::new()
        .route("/api/data", get(get_filters_data))
        .route("/api/generate", post(handle_generate))
        .route("/api/generate-image", post(handle_generate))
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_BODY_SIZE))
        .layer(io_layer)
        .layer(CorsLayer::permissive());

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|err| panic!("Không thể bind port {port}: {err}"));

    logger
        .info(&format!("🚀 Server đang chạy tại http://localhost:{port}"))
        .await;
    logger
        .info(&format!(
            "📡 Tích hợp Kira AI model: {kira_model} (Base URL: {kira_base_url})"
        ))
        .await;

    axum::serve(listener, app)
        .await
        .expect("Lỗi khi chạy HTTP server");
}

