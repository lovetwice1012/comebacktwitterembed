pub fn oracle_backoff(retry_count: u32) -> u64 {
    calc_backoff(retry_count)
}

pub fn oracle_decrypt(
    encrypted: &[u8],
    headers: &Option<std::collections::HashMap<String, String>>,
    keys: &crate::config::WebPushKeys,
) -> Result<Vec<u8>> {
    decrypt_ece(encrypted, headers, keys)
}

pub fn oracle_header(header: Option<&String>, name: &str) -> Result<String> {
    parse_header_param(header, name)
}

pub async fn oracle_handle_notification(
    data: &str,
    headers: &Option<std::collections::HashMap<String, String>>,
    keys: &crate::config::WebPushKeys,
) -> Result<()> {
    handle_notification_data(data, headers, keys).await
}

pub async fn oracle_webhook(payload: &serde_json::Value) -> Result<()> {
    send_to_webhook(payload).await
}
