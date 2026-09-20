import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';

test('loads Telnyx provider configuration', () => {
  const config = loadConfig({
    TELEPHONY_PROVIDER: 'telnyx',
    TELNYX_API_KEY: ' key ',
    TELNYX_CONNECTION_ID: ' connection ',
    TELNYX_FROM_NUMBER: ' +4915112345678 ',
    TELNYX_PUBLIC_KEY: ' public-key ',
  });

  assert.equal(config.telephonyProvider, 'telnyx');
  assert.equal(config.telnyxApiKey, 'key');
  assert.equal(config.telnyxConnectionId, 'connection');
  assert.equal(config.telnyxFromNumber, '+4915112345678');
  assert.equal(config.telnyxPublicKey, 'public-key');
});

test('rejects an unsupported telephony provider', () => {
  assert.throws(() => loadConfig({ TELEPHONY_PROVIDER: 'carrier-pigeon' }), /TELEPHONY_PROVIDER/);
});
