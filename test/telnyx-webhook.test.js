import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { validateTelnyxWebhook } from '../src/telnyx-webhook.js';

test('verifies a fresh Telnyx Ed25519 webhook signature', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rawBody = Buffer.from('{"data":{"event_type":"call.hangup"}}');
  const timestamp = '1700000000';
  const signature = sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]), privateKey).toString('base64');

  assert.equal(validateTelnyxWebhook({
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    signature,
    timestamp,
    rawBody,
    nowSeconds: 1700000010,
  }), true);
});

test('rejects tampered and stale Telnyx webhooks', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const timestamp = '1700000000';
  const signature = sign(null, Buffer.from(`${timestamp}|{}`), privateKey).toString('base64');
  const key = publicKey.export({ type: 'spki', format: 'pem' });

  assert.equal(validateTelnyxWebhook({
    publicKey: key, signature, timestamp, rawBody: Buffer.from('{"changed":true}'), nowSeconds: 1700000010,
  }), false);
  assert.equal(validateTelnyxWebhook({
    publicKey: key, signature, timestamp, rawBody: Buffer.from('{}'), nowSeconds: 1700001000,
  }), false);
});
