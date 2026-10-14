use crate::config::TwitterConfig;
use crate::error::{Result, AngelicAngelError};
use crate::push::PushSubscription;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Client;
use serde_json::json;

const TWITTER_API_BASE: &str = "https://x.com/i/api/1.1";
const AUTHORIZATION_BEARER: &str = "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const DEVICE_ID: &str = "Mac/Firefox";

pub async fn register(
    twitter_config: &TwitterConfig,
    push_subscription: &PushSubscription,
) -> Result<()> {
    let client = Client::new();
    register_push_subscription(&client, twitter_config, push_subscription).await?;
    Ok(())
}

async fn register_push_subscription(
    client: &Client,
    twitter_config: &TwitterConfig,
    push_subscription: &PushSubscription,
) -> Result<()> {
    let url = format!("{}/notifications/settings/login.json", TWITTER_API_BASE);

    let token = &push_subscription.endpoint;
    let encryption_key1 = URL_SAFE_NO_PAD.encode(&push_subscription.keys.public_key);
    let encryption_key2 = URL_SAFE_NO_PAD.encode(&push_subscription.keys.auth_secret);

    let body = json!({
        "push_device_info": {
            "os_version": DEVICE_ID,
            "udid": DEVICE_ID,
            "env": 3,
            "locale": "en",
            "protocol_version": 1,
            "token": token,
            "encryption_key1": encryption_key1,
            "encryption_key2": encryption_key2
        }
    });

    tracing::debug!(url = %url, "sending push subscription request");
    tracing::debug!(body = %serde_json::to_string_pretty(&body).unwrap(), "request body");

    let response = client
        .post(&url)
        .header("Authorization", AUTHORIZATION_BEARER)
        .header("x-csrf-token", &twitter_config.ct0)
        .header("x-twitter-auth-type", "OAuth2Session")
        .header("x-twitter-active-user", "yes")
        .header("x-twitter-client-language", "en")
        .header("Content-Type", "application/json")
        .header(
            "Cookie",
            format!(
                "auth_token={}; ct0={}",
                twitter_config.auth_token, twitter_config.ct0
            ),
        )
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    tracing::debug!(status = %status, "response status");

    if !response.status().is_success() {
        let error_text = response.text().await?;
        tracing::debug!(body = %error_text, "error response body");

        return Err(AngelicAngelError::TwitterApi(format!(
            "push subscription registration failed ({}): {}",
            status, error_text
        )));
    }

    let response_json: serde_json::Value = response.json().await?;
    tracing::debug!(body = %serde_json::to_string_pretty(&response_json).unwrap(), "success response body");

    Ok(())
}
