use crate::autopush::{self, ConnectResult};
use crate::config::{self, Registration};
use crate::error::{Result, AngelicAngelError};
use crate::twitter;
use reqwest::Client;
use std::path::Path;
use std::time::Duration;

/// Outcome of a single listen session.
///
/// Follows the design of Firefox's PushServiceWebSocket.sys.mjs, explicitly
/// distinguishing whether the connection was ever established. Firefox resets
/// _retryFailCount to 0 on any message receipt (including the hello response),
/// so we need to know if hello succeeded to mirror that behavior.
enum SessionOutcome {
    /// WebSocket closed normally (connection was established).
    NormalClose,
    /// Disconnected after a successful handshake (hello succeeded, then a WebSocket error).
    DisconnectedAfterConnect(AngelicAngelError),
    /// Failed before establishing a connection (hello never completed).
    ConnectionFailed(AngelicAngelError),
    /// Unrecoverable error (e.g. UAID invalidated and re-registration also failed).
    Fatal(AngelicAngelError),
}

/// Computes an exponential backoff delay compatible with Firefox's implementation.
///
/// Firefox (PushServiceWebSocket.sys.mjs L408-431):
///   retryTimeout = retryBaseInterval * 2^retryFailCount
///   retryTimeout = min(retryTimeout, pingInterval)
///
/// - retryBaseInterval = 5s  (dom.push.retryBaseInterval = 5000)
/// - pingInterval      = 5m  (capped; Firefox uses 30m but we use a shorter ping interval)
fn calc_backoff(retry_count: u32) -> u64 {
    const RETRY_BASE_INTERVAL_SECS: u64 = 5;
    const PING_INTERVAL_SECS: u64 = 5 * 60;
    std::cmp::min(
        RETRY_BASE_INTERVAL_SECS.saturating_mul(2u64.saturating_pow(retry_count.saturating_sub(1))),
        PING_INTERVAL_SECS,
    )
}

/// Main listen loop with automatic reconnection.
///
/// Reconnection strategy mirrors Firefox (PushServiceWebSocket.sys.mjs):
/// - Reset retry counter on any successful message receipt (connection established).
/// - No upper limit on retry attempts (infinite retries).
/// - Exponential backoff: 5s * 2^n, capped at 5 minutes.
/// - Server-initiated backoff via close code 4774 delays reconnection for 30 minutes.
pub async fn listen(mut registration: Registration, config_path: &Path) -> Result<()> {
    let mut retry_count: u32 = 0;

    loop {
        match listen_once(&mut registration, config_path).await {
            SessionOutcome::NormalClose => {
                retry_count = 0;
                tracing::info!("WebSocket connection closed, reconnecting");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            SessionOutcome::DisconnectedAfterConnect(e) => {
                if e.to_string().contains("BACKOFF:") {
                    tracing::warn!("server requested backoff, delaying reconnect for 30 minutes");
                    tokio::time::sleep(Duration::from_secs(30 * 60)).await;
                } else {
                    retry_count = 0;
                    tracing::info!(error = %e, "disconnected after connect, reconnecting");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
            SessionOutcome::ConnectionFailed(e) => {
                retry_count += 1;
                let delay = calc_backoff(retry_count);
                tracing::warn!(
                    retry_count,
                    delay_secs = delay,
                    error = %e,
                    "WebSocket connection failed, retrying"
                );
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
            SessionOutcome::Fatal(e) => {
                tracing::error!(error = %e, "fatal error, re-registration required");
                return Err(e);
            }
        }
    }
}

/// Runs a single listen session: connect, receive notifications, return outcome.
async fn listen_once(registration: &mut Registration, config_path: &Path) -> SessionOutcome {
    let mut client = match try_connect(registration, config_path).await {
        Ok(client) => client,
        Err(e) => {
            if e.to_string().contains("UAID invalid")
                || e.to_string().contains("still failed after re-registration")
            {
                return SessionOutcome::Fatal(e);
            }
            return SessionOutcome::ConnectionFailed(e);
        }
    };

    tracing::info!("WebSocket connection established, listening for notifications");

    match run_notification_loop(&mut client, registration).await {
        Ok(()) => SessionOutcome::NormalClose,
        Err(e) => SessionOutcome::DisconnectedAfterConnect(e),
    }
}

/// Establishes a connection to AutoPush, handling UAID invalidation transparently.
async fn try_connect(registration: &mut Registration, config_path: &Path) -> Result<autopush::AutoPushClient> {
    let connect_result =
        autopush::connect_and_listen(&registration.autopush, &registration.keys).await?;

    match connect_result {
        ConnectResult::Connected(client) => {
            tracing::info!("connected with existing session");
            Ok(client)
        }
        ConnectResult::NeedsReregistration(reregistration_info) => {
            let new_reg = &reregistration_info.registration;
            let new_keys = reregistration_info.keys;

            tracing::warn!(
                new_uaid = %new_reg.uaid,
                new_channel_id = %new_reg.channel_id,
                "UAID invalidated (pushsubscriptionchange), re-registering"
            );

            tracing::info!("re-registering with Twitter API");
            let mut full_config = config::Config::load(config_path)?;

            let subscription = crate::push::PushSubscription {
                endpoint: new_reg.endpoint.clone(),
                autopush: config::AutoPushSession {
                    uaid: new_reg.uaid.clone(),
                    channel_id: new_reg.channel_id.clone(),
                },
                keys: new_keys.clone(),
            };

            twitter::register(&full_config.twitter, &subscription).await?;
            tracing::info!("Twitter API re-registration complete");

            registration.endpoint = new_reg.endpoint.clone();
            registration.autopush.uaid = new_reg.uaid.clone();
            registration.autopush.channel_id = new_reg.channel_id.clone();
            registration.keys = new_keys;
            full_config.registration = Some(registration.clone());
            full_config.save(config_path)?;
            tracing::info!("saved updated registration");

            match autopush::connect_and_listen(&registration.autopush, &registration.keys).await? {
                ConnectResult::Connected(client) => Ok(client),
                ConnectResult::NeedsReregistration(_) => Err(AngelicAngelError::AutoPush(
                    "still failed after re-registration".to_string(),
                )),
            }
        }
    }
}

/// Receives and processes notifications in a loop until the connection drops.
async fn run_notification_loop(
    client: &mut autopush::AutoPushClient,
    registration: &Registration,
) -> Result<()> {
    while let Some(notification) = client.next_notification().await? {
        tracing::info!(
            channel_id = %notification.channel_id,
            version = %notification.version,
            "notification received"
        );

        let ack_code = if let Some(ref data) = notification.data {
            match handle_notification_data(data, &notification.headers, &registration.keys).await {
                Ok(()) => autopush::AckCode::Delivered,
                Err(ref e) if is_decryption_error(e) => {
                    tracing::warn!(error = %e, "decryption error, sending ACK with decryption_error");
                    autopush::AckCode::DecryptionError
                }
                Err(ref e) => {
                    tracing::warn!(error = %e, "notification processing error, sending ACK with not_delivered");
                    autopush::AckCode::NotDelivered
                }
            }
        } else {
            tracing::info!("empty notification (no data)");
            autopush::AckCode::Delivered
        };

        client
            .ack_notification(
                notification.channel_id.clone(),
                notification.version.clone(),
                ack_code,
            )
            .await?;
        tracing::debug!(
            channel_id = %notification.channel_id,
            ack_code = ?ack_code,
            "ACK sent"
        );
    }

    Ok(())
}

fn is_decryption_error(e: &AngelicAngelError) -> bool {
    matches!(e, AngelicAngelError::Decryption(_))
}

async fn handle_notification_data(
    data: &str,
    headers: &Option<std::collections::HashMap<String, String>>,
    keys: &crate::config::WebPushKeys,
) -> Result<()> {
    let encrypted = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, data)
        .map_err(|e| AngelicAngelError::Decryption(format!("base64 decode failed: {}", e)))?;

    tracing::debug!(encrypted_size = encrypted.len(), "decoding encrypted message");

    if let Some(hdrs) = headers {
        tracing::debug!(?hdrs, "notification headers");
    }

    let decrypted = match decrypt_ece(&encrypted, headers, keys) {
        Ok(decrypted) => {
            tracing::debug!(decrypted_size = decrypted.len(), "ECE decryption succeeded");
            decrypted
        }
        Err(e) => {
            tracing::error!(
                error = %e,
                encrypted_head = ?&encrypted[..encrypted.len().min(16)],
                "ECE decryption failed"
            );
            return Err(e);
        }
    };

    let text = String::from_utf8(decrypted)
        .map_err(|e| AngelicAngelError::Decryption(format!("UTF-8 conversion failed: {}", e)))?;

    let payload: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));

    tracing::info!(payload = %payload, "notification decrypted");

    send_to_webhook(&payload).await?;

    Ok(())
}

/// Sends the decrypted notification payload to the configured webhook endpoint via HTTP POST.
async fn send_to_webhook(payload: &serde_json::Value) -> Result<()> {
    let webhook_url = config::get_webhook_endpoint()?;
    let client = Client::new();

    tracing::info!(url = %webhook_url, "sending to webhook");

    let response = client.post(&webhook_url).json(payload).send().await?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|_| String::from("failed to read response body"));
        tracing::warn!(status = %status, body = %error_text, "webhook request failed");
    } else {
        tracing::info!(status = %response.status(), "webhook request succeeded");
    }

    Ok(())
}

fn decrypt_ece(
    encrypted: &[u8],
    headers: &Option<std::collections::HashMap<String, String>>,
    keys: &crate::config::WebPushKeys,
) -> Result<Vec<u8>> {
    tracing::debug!(
        private_key_len = keys.private_key.len(),
        public_key_len = keys.public_key.len(),
        auth_secret_len = keys.auth_secret.len(),
        encrypted_len = encrypted.len(),
        "starting ECE decryption"
    );

    let key_pair = ece::EcKeyComponents::new(keys.private_key.clone(), keys.public_key.clone());

    let encoding = headers
        .as_ref()
        .and_then(|h| h.get("encoding"))
        .map(|s| s.as_str());

    match encoding {
        Some("aesgcm") => {
            tracing::debug!("decrypting with aesgcm encoding");
            decrypt_aesgcm(encrypted, headers, &key_pair, &keys.auth_secret)
        }
        Some("aes128gcm") | None => {
            tracing::debug!("decrypting with aes128gcm encoding");
            let decrypted = ece::decrypt(&key_pair, &keys.auth_secret, encrypted).map_err(|e| {
                tracing::debug!(error = %e, "aes128gcm decryption error");
                AngelicAngelError::Decryption(format!("aes128gcm decryption failed: {}", e))
            })?;

            tracing::debug!(decrypted_len = decrypted.len(), "aes128gcm decryption succeeded");
            Ok(decrypted)
        }
        Some(other) => Err(AngelicAngelError::Decryption(format!(
            "unsupported encoding: {}",
            other
        ))),
    }
}

fn decrypt_aesgcm(
    encrypted: &[u8],
    headers: &Option<std::collections::HashMap<String, String>>,
    key_pair: &ece::EcKeyComponents,
    auth_secret: &[u8],
) -> Result<Vec<u8>> {
    let headers = headers.as_ref().ok_or_else(|| {
        AngelicAngelError::Decryption("aesgcm encoding requires headers but none were provided".to_string())
    })?;

    let dh_b64 = parse_header_param(headers.get("crypto_key"), "dh")?;
    let sender_public_key =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &dh_b64)
            .map_err(|e| {
                AngelicAngelError::Decryption(format!("failed to base64-decode sender public key: {}", e))
            })?;

    tracing::debug!(sender_public_key_len = sender_public_key.len(), "parsed sender public key");

    let salt_b64 = parse_header_param(headers.get("encryption"), "salt")?;
    let salt = base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &salt_b64)
        .map_err(|e| AngelicAngelError::Decryption(format!("failed to base64-decode salt: {}", e)))?;

    tracing::debug!(salt_len = salt.len(), "parsed salt");

    let block = ece::legacy::AesGcmEncryptedBlock::new(
        &sender_public_key,
        &salt,
        4096,
        encrypted.to_vec(),
    )
    .map_err(|e| AngelicAngelError::Decryption(format!("failed to construct AesGcmEncryptedBlock: {}", e)))?;

    let decrypted = ece::legacy::decrypt_aesgcm(key_pair, auth_secret, &block).map_err(|e| {
        tracing::debug!(error = %e, "aesgcm decryption error");
        AngelicAngelError::Decryption(format!("aesgcm decryption failed: {}", e))
    })?;

    tracing::debug!(decrypted_len = decrypted.len(), "aesgcm decryption succeeded");
    Ok(decrypted)
}

/// Extracts a named parameter from a semicolon-delimited header value.
///
/// Example: given `"dh=abc123;p256ecdsa=xyz"` and param `"dh"`, returns `"abc123"`.
fn parse_header_param(header_value: Option<&String>, param_name: &str) -> Result<String> {
    let header = header_value.ok_or_else(|| {
        AngelicAngelError::Decryption(format!("missing required header for param '{}'", param_name))
    })?;

    for part in header.split(';') {
        let part = part.trim();
        if let Some(value) = part.strip_prefix(&format!("{}=", param_name)) {
            return Ok(value.to_string());
        }
    }

    Err(AngelicAngelError::Decryption(format!(
        "param '{}' not found in header: {}",
        param_name, header
    )))
}
