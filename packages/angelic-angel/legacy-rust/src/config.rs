use crate::error::{Result, AngelicAngelError};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub twitter: TwitterConfig,
    pub registration: Option<Registration>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitterConfig {
    pub auth_token: String,
    pub ct0: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebPushKeys {
    pub public_key: Vec<u8>,
    pub private_key: Vec<u8>,
    pub auth_secret: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoPushSession {
    pub uaid: String,
    pub channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Registration {
    pub endpoint: String,
    pub autopush: AutoPushSession,
    pub keys: WebPushKeys,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path).map_err(|e| {
            AngelicAngelError::Config(format!("failed to read config ({}): {}", path.display(), e))
        })?;
        toml::from_str(&content).map_err(Into::into)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let content = toml::to_string_pretty(self)
            .map_err(|e| AngelicAngelError::Config(format!("failed to serialize config: {}", e)))?;
        std::fs::write(path, content)?;
        Ok(())
    }
}

/// Reads the webhook endpoint URL from the WEBHOOK_ENDPOINT environment variable.
pub fn get_webhook_endpoint() -> Result<String> {
    std::env::var("WEBHOOK_ENDPOINT").map_err(|_| {
        AngelicAngelError::Config("WEBHOOK_ENDPOINT environment variable is not set".to_string())
    })
}
