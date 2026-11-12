use std::env;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub port: u16,
    pub kira_base_url: String,
    pub kira_model: String,
    pub kira_api_key: Option<String>,
}

impl AppConfig {
    pub fn from_env() -> Self {
        dotenvy::dotenv().ok();

        let port = env::var("PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(4000);

        let kira_base_url = env::var("KIRA_BASE_URL")
            .unwrap_or_else(|_| "https://kiraai.vn/api/v1".to_string())
            .trim_end_matches('/')
            .to_string();

        let kira_model = env::var("KIRA_MODEL").unwrap_or_else(|_| "kira-2.0-image".to_string());

        let kira_api_key = env::var("KIRA_API_KEY")
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());

        Self {
            port,
            kira_base_url,
            kira_model,
            kira_api_key,
        }
    }

    pub fn valid_api_key(&self) -> Option<&str> {
        self.kira_api_key
            .as_deref()
            .filter(|k| !k.is_empty() && *k != "YOUR_KIRA_API_KEY")
    }
}

