#![allow(dead_code)] // Every retained module is compiled; the oracle exposes only isolated operations.
mod autopush {
    include!(concat!(env!("OUT_DIR"), "/autopush.rs"));
}
mod cli {
    include!(concat!(env!("OUT_DIR"), "/cli.rs"));
}
mod config {
    include!(concat!(env!("OUT_DIR"), "/config.rs"));
}
mod error {
    include!(concat!(env!("OUT_DIR"), "/error.rs"));
}
mod listener {
    include!(concat!(env!("OUT_DIR"), "/listener.rs"));
}
mod push {
    include!(concat!(env!("OUT_DIR"), "/push.rs"));
}
mod twitter {
    include!(concat!(env!("OUT_DIR"), "/twitter.rs"));
}

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::io::{self, BufRead};

fn required<'a>(value: &'a Value, name: &str) -> &'a Value {
    value.get(name).unwrap_or(&Value::Null)
}

async fn run(input: &Value) -> std::result::Result<Value, Box<dyn std::error::Error>> {
    for variable in ["WEBHOOK_ENDPOINT", "ANGELIC_ORACLE_TWITTER_URL"] {
        if let Ok(endpoint) = std::env::var(variable) {
            let url = reqwest::Url::parse(&endpoint)?;
            if url.scheme() != "http"
                || !matches!(
                    url.host_str(),
                    Some("127.0.0.1") | Some("::1") | Some("[::1]")
                )
            {
                return Err("oracle HTTP endpoints must be loopback".into());
            }
        }
    }
    Ok(match input["operation"].as_str().unwrap_or("") {
        "config_parse" => {
            let parsed: config::Config = toml::from_str(input["toml"].as_str().unwrap_or(""))?;
            serde_json::to_value(parsed)?
        }
        "config_save" => {
            let parsed: config::Config = serde_json::from_value(required(input, "config").clone())?;
            json!(toml::to_string_pretty(&parsed)?)
        }
        "config_load" => serde_json::to_value(config::Config::load(std::path::Path::new(
            input["path"].as_str().unwrap_or(""),
        ))?)?,
        "config_write" => {
            let parsed: config::Config = serde_json::from_value(required(input, "config").clone())?;
            parsed.save(std::path::Path::new(input["path"].as_str().unwrap_or("")))?;
            Value::Null
        }
        "protocol_serialize" => {
            autopush::oracle_serialize_message(required(input, "message").clone())?
        }
        "protocol_parse" => autopush::oracle_parse_response(input["text"].as_str().unwrap_or(""))?,
        "pong" => json!(autopush::oracle_is_pong(
            input["text"].as_str().unwrap_or("")
        )),
        "backoff_close" => json!(autopush::oracle_is_backoff(
            input["code"].as_u64().map(|x| x as u16)
        )),
        "backoff" => json!(listener::oracle_backoff(
            input["count"].as_u64().unwrap_or(0) as u32
        )),
        "header" => {
            let header = input["header"].as_str().map(String::from);
            json!(listener::oracle_header(
                header.as_ref(),
                input["name"].as_str().unwrap_or("")
            )?)
        }
        "keys" => serde_json::to_value(push::generate_keys())?,
        "register" => {
            let keys: config::WebPushKeys =
                serde_json::from_value(required(input, "keys").clone())?;
            let registration = autopush::register_new(&keys).await?;
            json!({"uaid":registration.uaid,"channel_id":registration.channel_id,
                "endpoint":registration.endpoint})
        }
        "unregister" => {
            let session: config::AutoPushSession =
                serde_json::from_value(required(input, "session").clone())?;
            autopush::unregister(&session).await?;
            Value::Null
        }
        "session" => {
            let session: config::AutoPushSession =
                serde_json::from_value(required(input, "session").clone())?;
            let keys: config::WebPushKeys =
                serde_json::from_value(required(input, "keys").clone())?;
            match autopush::connect_and_listen(&session, &keys).await? {
                autopush::ConnectResult::NeedsReregistration(info) => json!({
                    "reregister":true,"uaid":info.registration.uaid,
                    "channel_id":info.registration.channel_id,"endpoint":info.registration.endpoint,
                    "keys":info.keys}),
                autopush::ConnectResult::Connected(mut client) => {
                    let mut received = Vec::new();
                    while let Some(notification) = client.next_notification().await? {
                        client
                            .ack_notification(
                                notification.channel_id.clone(),
                                notification.version.clone(),
                                autopush::AckCode::Delivered,
                            )
                            .await?;
                        received.push(json!({"channelID":notification.channel_id,
                            "version":notification.version,"data":notification.data,"headers":notification.headers}));
                    }
                    json!({"reregister":false,"notifications":received})
                }
            }
        }
        "twitter" => {
            let twitter: config::TwitterConfig =
                serde_json::from_value(required(input, "twitter").clone())?;
            let registration: config::Registration =
                serde_json::from_value(required(input, "registration").clone())?;
            twitter::register(
                &twitter,
                &push::PushSubscription {
                    endpoint: registration.endpoint,
                    autopush: registration.autopush,
                    keys: registration.keys,
                },
            )
            .await?;
            Value::Null
        }
        "encrypt" => {
            let keys: config::WebPushKeys =
                serde_json::from_value(required(input, "keys").clone())?;
            let data = URL_SAFE_NO_PAD.decode(input["data"].as_str().unwrap_or(""))?;
            match input["encoding"].as_str().unwrap_or("aes128gcm") {
                "aes128gcm" => json!({"data":URL_SAFE_NO_PAD.encode(ece::encrypt(
                    &keys.public_key, &keys.auth_secret, &data)?), "headers":{"encoding":"aes128gcm"}}),
                "aesgcm" => {
                    let block =
                        ece::legacy::encrypt_aesgcm(&keys.public_key, &keys.auth_secret, &data)?;
                    let mut headers = std::collections::HashMap::new();
                    headers.insert("encoding".to_string(), "aesgcm".to_string());
                    for (key, value) in block.headers(None) {
                        match key.to_ascii_lowercase().as_str() {
                            "crypto-key" => {
                                headers.insert("crypto_key".to_string(), value);
                            }
                            "encryption" => {
                                headers.insert("encryption".to_string(), value);
                            }
                            _ => {}
                        }
                    }
                    json!({"data":block.body(),"headers":headers})
                }
                _ => return Err("unknown encryption mode".into()),
            }
        }
        "decrypt" => {
            let keys: config::WebPushKeys =
                serde_json::from_value(required(input, "keys").clone())?;
            let data = URL_SAFE_NO_PAD.decode(input["data"].as_str().unwrap_or(""))?;
            let headers = serde_json::from_value(required(input, "headers").clone())?;
            json!(URL_SAFE_NO_PAD.encode(listener::oracle_decrypt(&data, &headers, &keys)?))
        }
        "webhook" => {
            listener::oracle_webhook(required(input, "payload")).await?;
            Value::Null
        }
        "notification" => {
            let keys: config::WebPushKeys =
                serde_json::from_value(required(input, "keys").clone())?;
            let headers = serde_json::from_value(required(input, "headers").clone())?;
            let result = listener::oracle_handle_notification(
                input["data"].as_str().unwrap_or(""),
                &headers,
                &keys,
            )
            .await;
            match result {
                Ok(()) => json!({"ack":100}),
                Err(error::AngelicAngelError::Decryption(_)) => json!({"ack":101}),
                Err(_) => json!({"ack":102}),
            }
        }
        _ => return Err("unknown oracle operation".into()),
    })
}

#[tokio::main]
async fn main() {
    for line in io::stdin().lock().lines() {
        let response = match line {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(input) => match run(&input).await {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                },
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            },
            Err(error) => json!({"ok":false,"error":error.to_string()}),
        };
        println!("{}", response);
    }
}
