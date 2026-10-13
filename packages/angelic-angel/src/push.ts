import { createECDH, randomBytes } from 'node:crypto';
import { registerNew, type AutoPushOptions } from './autopush.js';
import type { AutoPushSession, WebPushKeys } from './config.js';
import { AngelicAngelError } from './errors.js';

/** The subscription shape and byte arrays are identical to the Rust TOML schema. */
export interface PushSubscription {
  endpoint: string;
  autopush: AutoPushSession;
  keys: WebPushKeys;
}

/** Firefox and the Rust baseline generate a fresh P-256 pair on every subscription. */
export function generateKeys(): WebPushKeys {
  const keyPair = createECDH('prime256v1');
  keyPair.generateKeys();
  const scalar = keyPair.getPrivateKey();
  // Explicit left padding preserves the fixed-width p256::SecretKey::to_bytes format.
  const privateKey = Buffer.alloc(32);
  scalar.copy(privateKey, privateKey.length - scalar.length);
  return {
    public_key: [...keyPair.getPublicKey(undefined, 'uncompressed')],
    private_key: [...privateKey],
    auth_secret: [...randomBytes(16)],
  };
}

export async function subscribe(
  register: (keys: WebPushKeys, options?: AutoPushOptions) => ReturnType<typeof registerNew> = registerNew,
  options?: AutoPushOptions,
): Promise<PushSubscription> {
  const keys = generateKeys();
  try {
    const registration = await register(keys, options);
    return {
      endpoint: registration.endpoint,
      autopush: { uaid: registration.uaid, channel_id: registration.channel_id },
      keys,
    };
  } catch (cause) {
    throw new AngelicAngelError('AutoPush', 'AutoPush registration failed', { cause });
  }
}
