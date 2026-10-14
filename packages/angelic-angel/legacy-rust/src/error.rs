use thiserror::Error;

#[derive(Error, Debug)]
pub enum AngelicAngelError {
    #[error("config error: {0}")]
    Config(String),

    #[error("AutoPush error: {0}")]
    AutoPush(String),

    #[error("Twitter API error: {0}")]
    TwitterApi(String),

    #[error("WebSocket error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    #[error("decryption error: {0}")]
    Decryption(String),

    #[error("ECE error: {0}")]
    #[allow(dead_code)]
    Ece(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("TOML error: {0}")]
    Toml(#[from] toml::de::Error),

    #[error("base64 decode error: {0}")]
    Base64Decode(#[from] base64::DecodeError),
}

pub type Result<T> = std::result::Result<T, AngelicAngelError>;
