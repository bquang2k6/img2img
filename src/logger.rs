use std::sync::Mutex;
use std::time::Instant;

use chrono::Local;
use serde::Serialize;
use socketioxide::SocketIo;

#[derive(Serialize)]
struct LogEvent {
    time: String,
    message: String,
    #[serde(rename = "type")]
    log_type: &'static str,
}

pub struct AppLogger {
    last_log_time: Mutex<Instant>,
    io: SocketIo,
}

impl AppLogger {
    pub fn new(io: SocketIo) -> Self {
        Self {
            last_log_time: Mutex::new(Instant::now()),
            io,
        }
    }

    fn format_log_time(&self) -> String {
        let now = Instant::now();
        let diff = {
            let mut last = self.last_log_time.lock().unwrap();
            let elapsed = now.duration_since(*last).as_secs_f64();
            *last = now;
            elapsed
        };
        let time_str = Local::now().format("%H:%M:%S");
        format!("[{time_str} | +{diff:.1}s]")
    }

    pub async fn info(&self, msg: &str) {
        let formatted_time = self.format_log_time();
        println!("{formatted_time} {msg}");
        self.emit_if_mapped(&formatted_time, msg, "info").await;
    }

    pub async fn error(&self, msg: &str) {
        let formatted_time = self.format_log_time();
        eprintln!("{formatted_time} {msg}");
        self.emit_if_mapped(&formatted_time, msg, "error").await;
    }

    async fn emit_if_mapped(&self, formatted_time: &str, msg: &str, log_type: &'static str) {
        if let Some(mapped) = map_log_to_client_message(msg) {
            let payload = LogEvent {
                time: formatted_time.to_string(),
                message: mapped,
                log_type,
            };
            let _ = self.io.emit("log", &payload).await;
        }
    }
}

fn map_log_to_client_message(msg: &str) -> Option<String> {
    if msg.contains("🎨 Nhận yêu cầu tạo ảnh mới") {
        Some("Đang nhận yêu cầu...".to_string())
    } else if msg.contains("⚡ Đang gửi yêu cầu tới Kira AI") {
        Some("Đang gửi yêu cầu tới Kira AI...".to_string())
    } else if msg.contains("✨ Đã tạo ảnh thành công từ Kira AI") {
        Some("Tạo ảnh thành công!".to_string())
    } else if msg.contains("❌ Lỗi") {
        Some(msg.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::map_log_to_client_message;

    #[test]
    fn maps_expected_log_messages() {
        assert_eq!(
            map_log_to_client_message("🎨 Nhận yêu cầu tạo ảnh mới...").as_deref(),
            Some("Đang nhận yêu cầu...")
        );
        assert_eq!(
            map_log_to_client_message("⚡ Đang gửi yêu cầu tới Kira AI (Model: kira-2.0-image)...")
                .as_deref(),
            Some("Đang gửi yêu cầu tới Kira AI...")
        );
        assert_eq!(
            map_log_to_client_message("✨ Đã tạo ảnh thành công từ Kira AI!").as_deref(),
            Some("Tạo ảnh thành công!")
        );
        assert_eq!(
            map_log_to_client_message("❌ Lỗi từ Kira AI: bad key").as_deref(),
            Some("❌ Lỗi từ Kira AI: bad key")
        );
        assert_eq!(map_log_to_client_message("other log"), None);
    }
}


