import { createPublicKey, verify } from 'node:crypto';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function validateTelnyxWebhook({
  publicKey,
  signature,
  timestamp,
  rawBody,
  nowSeconds = Math.floor(Date.now() / 1_000),
  toleranceSeconds = 300,
}) {
  if (!publicKey || !signature || !timestamp || !rawBody) return false;
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(nowSeconds - sentAt) > toleranceSeconds) return false;
  try {
    const key = parsePublicKey(publicKey);
    const message = Buffer.concat([Buffer.from(`${timestamp}|`), Buffer.from(rawBody)]);
    return verify(null, message, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function parsePublicKey(value) {
  const text = String(value).trim();
  if (text.includes('BEGIN PUBLIC KEY')) return createPublicKey(text);
  const raw = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (raw.length !== 32) throw new Error('TELNYX_PUBLIC_KEY must be a 32-byte Ed25519 key');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}
