import test from 'node:test';
import assert from 'node:assert/strict';

import { TelnyxTelephony } from '../src/telnyx-telephony.js';

const tunnel = {
  ready: true,
  mediaWebSocketUrl: (token) => `wss://media.example.test/media-stream/${token}`,
  callbackUrl: (path) => `https://media.example.test/${path}`,
};

const run = {
  id: 'run-1',
  instruction: { phone_number: '+4915112345678' },
  providerCallId: 'v3:call-control-id',
};

function fakeFetch(responses = []) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const response = responses.shift() ?? { status: 200, body: { data: { call_control_id: 'v3:call-control-id' } } };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json() { return response.body; },
      async text() { return JSON.stringify(response.body); },
    };
  };
  fetch.calls = calls;
  return fetch;
}

test('dials through Telnyx with authenticated bidirectional PCMU streaming', async () => {
  const fetch = fakeFetch();
  const mediaSessions = new Map();
  const telephony = new TelnyxTelephony({
    apiKey: 'KEY123',
    connectionId: 'connection-1',
    fromNumber: '+4915112345678',
    fetch,
    tunnel,
    mediaSessions,
    tokenFactory: () => 'media-token',
  });

  const result = await telephony.start({ run, prompt: 'guarded prompt' });

  assert.deepEqual(result, { providerCallId: 'v3:call-control-id' });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'https://api.telnyx.com/v2/calls');
  assert.equal(fetch.calls[0].options.method, 'POST');
  assert.equal(fetch.calls[0].options.headers.authorization, 'Bearer KEY123');
  const body = JSON.parse(fetch.calls[0].options.body);
  assert.deepEqual(body, {
    connection_id: 'connection-1',
    to: '+4915112345678',
    from: '+4915112345678',
    stream_url: 'wss://media.example.test/media-stream/media-token',
    webhook_url: 'https://media.example.test/telnyx/webhook',
    stream_track: 'inbound_track',
    stream_codec: 'PCMU',
    stream_bidirectional_mode: 'rtp',
    stream_bidirectional_codec: 'PCMU',
    stream_bidirectional_sampling_rate: 8000,
    stream_bidirectional_target_legs: 'self',
    client_state: Buffer.from(JSON.stringify({ token: 'media-token' })).toString('base64'),
  });
  assert.deepEqual(mediaSessions.get('media-token'), {
    provider: 'telnyx',
    runId: 'run-1',
    prompt: 'guarded prompt',
    providerCallId: 'v3:call-control-id',
  });
});

test('hangs up the exact Telnyx call control id', async () => {
  const fetch = fakeFetch([{ status: 200, body: { data: { result: 'ok' } } }]);
  const telephony = new TelnyxTelephony({
    apiKey: 'KEY123', connectionId: 'connection-1', fromNumber: '+4915112345678',
    fetch, tunnel, mediaSessions: new Map(), tokenFactory: () => 'token',
  });

  await telephony.hangup(run);

  assert.equal(fetch.calls[0].url, 'https://api.telnyx.com/v2/calls/v3%3Acall-control-id/actions/hangup');
  assert.equal(fetch.calls[0].options.method, 'POST');
});

test('cleans up the media capability when Telnyx rejects the dial', async () => {
  const fetch = fakeFetch([{ status: 403, body: { errors: [{ detail: 'unverified caller' }] } }]);
  const mediaSessions = new Map();
  const telephony = new TelnyxTelephony({
    apiKey: 'KEY123', connectionId: 'connection-1', fromNumber: '+4915112345678',
    fetch, tunnel, mediaSessions, tokenFactory: () => 'token',
  });

  await assert.rejects(() => telephony.start({ run, prompt: 'prompt' }), /unverified caller/);
  assert.equal(mediaSessions.size, 0);
});

test('reports ready only with complete Telnyx credentials and tunnel', () => {
  const complete = new TelnyxTelephony({
    apiKey: 'key', connectionId: 'connection', fromNumber: '+4915112345678',
    fetch: fakeFetch(), tunnel, mediaSessions: new Map(),
  });
  const incomplete = new TelnyxTelephony({
    apiKey: undefined, connectionId: 'connection', fromNumber: '+4915112345678',
    fetch: fakeFetch(), tunnel, mediaSessions: new Map(),
  });

  assert.equal(complete.ready, true);
  assert.equal(incomplete.ready, false);
});
