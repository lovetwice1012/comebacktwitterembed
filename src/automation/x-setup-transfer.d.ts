import type { Buffer } from 'node:buffer';
import type { KeyObject } from 'node:crypto';

export const MAX_FILE_BYTES: 32768;
export interface FirefoxTransferFile {
    format: 'x-notification-subscription';
    version: 1;
    provenance: { kind: 'firefox-pushdb'; adapterVersion: '1.0.0'; browserVersion: string; readMethod: 'gecko-indexeddb-readonly' };
    push: {
        uaid: string; channelID: string; pushEndpoint: string; scope: string; originAttributes: '';
        p256dhPublicKey: string; authenticationSecret: string;
        p256dhPrivateKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string; ext: true; key_ops: ['deriveBits'] };
    };
}
export interface ChromeTransferFile {
    format: 'x-notification-subscription';
    version: 2;
    provenance: { kind: 'chrome-gcm'; adapterVersion: '1.0.0'; browserVersion: string; readMethod: 'chrome-gcm-snapshot' };
    push: { deviceId: string; securityToken: string; appId: string; productCategory: 'com.chrome.windows'; authorizedEntity: string;
        scope: 'https://x.com/'; p256dhPublicKey: string; authenticationSecret: string;
        p256dhPrivateKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string } };
}
export interface BraveTransferFile extends Omit<ChromeTransferFile, 'provenance' | 'push'> {
    provenance: { kind: 'brave-gcm'; adapterVersion: '1.0.0'; browserVersion: string; engineVersion: string; readMethod: 'brave-gcm-snapshot' };
    push: Omit<ChromeTransferFile['push'], 'productCategory'> & { productCategory: 'com.brave.windows' };
}
export type TransferFile = FirefoxTransferFile | ChromeTransferFile | BraveTransferFile;
export interface TransferIdentity { uaidHash: string; channelHash: string; contentHash: string }
export interface TransferContext { subscriptionId: string; ownerUserId: string; revision: number }
export interface TransferVaultOptions { activeKeyId: string; keys: Record<string, Buffer> | Map<string, Buffer> }
export interface TransferEnvelope { version: 1; algorithm: 'A256GCM'; keyId: string; iv: string; ciphertext: string; tag: string }
export interface TransferSealer { seal(file: TransferFile, context: TransferContext): TransferEnvelope }
export interface TransferWorkerVault extends TransferSealer { open(envelope: TransferEnvelope, context: TransferContext): TransferFile }
export function parseTransferFile(fileText: string): TransferFile;
export function identifyTransfer(file: TransferFile): TransferIdentity;
export function createTransferSealer(options: TransferVaultOptions): TransferSealer;
/** Trusted worker constructor; never provide this object to web intake. */
export function createTransferWorkerVault(options: TransferVaultOptions): TransferWorkerVault;
export interface TransferPublicSealerOptions { activeKeyId: string; publicKeys: Record<string, KeyObject | string> | Map<string, KeyObject | string> }
export interface TransferPrivateWorkerOptions { activeKeyId: string; privateKeys: Record<string, KeyObject | string> | Map<string, KeyObject | string> }
export interface TransferHybridEnvelope { version: 2; algorithm: 'RSA-OAEP-256+A256GCM'; keyId: string; wrappedKey: string; iv: string; ciphertext: string; tag: string }
export interface TransferPublicSealer { seal(file: TransferFile, context: TransferContext): TransferHybridEnvelope }
export interface TransferPrivateWorkerVault { open(envelope: TransferHybridEnvelope, context: TransferContext): TransferFile }
/** Web intake role: accepts RSA public material only and has no decryption API. */
export function createTransferPublicSealer(options: TransferPublicSealerOptions): TransferPublicSealer;
/** Worker role: accepts RSA private material only and has no encryption API. */
export function createTransferPrivateWorkerVault(options: TransferPrivateWorkerOptions): TransferPrivateWorkerVault;
export interface WnsTokenContext extends TransferContext { generation: number }
export interface WnsTokenEnvelope extends Omit<TransferHybridEnvelope, 'version'> { version: 1 }
/** Worker only. The caller must clear the returned plaintext Buffer after use. */
export function createWnsTokenWorkerVault(options: TransferPrivateWorkerOptions): {
    seal(token: Buffer, context: WnsTokenContext): WnsTokenEnvelope;
    open(envelope: WnsTokenEnvelope, context: WnsTokenContext): Buffer;
};
