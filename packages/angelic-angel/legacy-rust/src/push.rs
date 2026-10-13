use crate::autopush;
use crate::config::{AutoPushSession, WebPushKeys};
use crate::error::{Result, AngelicAngelError};
use p256::SecretKey;
use rand::RngCore;

/// Holds the result of a push subscription registration.
#[derive(Clone)]
pub struct PushSubscription {
    pub endpoint: String,
    pub autopush: AutoPushSession,
    pub keys: WebPushKeys,
}

/// Generates a fresh ECDH P-256 key pair and a random auth secret.
///
/// Mirrors Firefox's behavior of always generating new keys on re-subscription
/// rather than reusing old ones (see PushCrypto.sys.mjs: generateKeys()).
pub fn generate_keys() -> WebPushKeys {
    let secret_key = SecretKey::random(&mut rand::rngs::OsRng);
    let public_key = secret_key.public_key();

    // SEC1 uncompressed form (65 bytes)
    let public_key_bytes = public_key.to_sec1_bytes().to_vec();
    // Raw scalar (32 bytes)
    let private_key_bytes = secret_key.to_bytes().to_vec();
    // Random auth secret (16 bytes)
    let mut auth_secret = vec![0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut auth_secret);

    WebPushKeys {
        public_key: public_key_bytes,
        private_key: private_key_bytes,
        auth_secret,
    }
}

/// Registers with Mozilla AutoPush and returns a complete push subscription.
pub async fn subscribe() -> Result<PushSubscription> {
    let keys = generate_keys();

    let registration = autopush::register_new(&keys)
        .await
        .map_err(|e| AngelicAngelError::AutoPush(format!("AutoPush registration failed: {}", e)))?;

    Ok(PushSubscription {
        endpoint: registration.endpoint,
        autopush: AutoPushSession {
            uaid: registration.uaid,
            channel_id: registration.channel_id,
        },
        keys,
    })
}
