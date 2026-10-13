pub fn oracle_serialize_message(value: serde_json::Value) -> Result<serde_json::Value> {
    let message: AutoPushMessage = serde_json::from_value(value)?;
    Ok(serde_json::to_value(message)?)
}

pub fn oracle_parse_response(text: &str) -> Result<serde_json::Value> {
    let response: AutoPushResponse = serde_json::from_str(text)?;
    Ok(match response {
        AutoPushResponse::Hello {
            status,
            uaid,
            use_webpush,
            broadcasts,
        } => serde_json::json!({"messageType":"hello", "status":status, "uaid":uaid,
                "use_webpush":use_webpush, "broadcasts":broadcasts}),
        AutoPushResponse::Register {
            status,
            push_endpoint,
            channel_id,
        } => serde_json::json!({"messageType":"register", "status":status,
                "pushEndpoint":push_endpoint, "channelID":channel_id}),
        AutoPushResponse::Notification {
            channel_id,
            version,
            data,
            headers,
        } => serde_json::json!({"messageType":"notification", "channelID":channel_id,
                "version":version, "data":data, "headers":headers}),
    })
}

pub fn oracle_is_pong(text: &str) -> bool {
    is_pong(text)
}

pub fn oracle_is_backoff(code: Option<u16>) -> bool {
    let frame = code.map(
        |value| tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::from(value),
            reason: "".into(),
        },
    );
    is_backoff_close(&frame)
}
fn oracle_endpoint() -> String {
    let endpoint = std::env::var("ANGELIC_ORACLE_WS_URL").expect("mock AutoPush endpoint required");
    let url = reqwest::Url::parse(&endpoint).expect("invalid mock URL");
    assert!(
        matches!(url.scheme(), "ws" | "wss")
            && matches!(
                url.host_str(),
                Some("127.0.0.1") | Some("[::1]") | Some("::1")
            ),
        "oracle permits only loopback WebSocket endpoints"
    );
    endpoint
}

fn oracle_duration(default_seconds: u64, variable: &str) -> Duration {
    match std::env::var(variable)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(value) if value > 0 => Duration::from_millis(value),
        _ => Duration::from_secs(default_seconds),
    }
}
