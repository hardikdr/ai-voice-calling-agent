import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMediaServer } from '../src/media-server.js';
import { RunStore } from '../src/run-store.js';

const instruction = {
  phone_number: '+4930123456', language: 'de', my_name: 'Ada', objective: 'Ask a question.',
  allowed_times: [], forbidden_times: [], facts_agent_may_disclose: [],
  actions_agent_may_take: ['ask'], actions_requiring_confirmation: [], dry_run: false,
};

async function setup(options = {}) {
  const storagePath = await mkdtemp(join(tmpdir(), 'calling-agent-media-'));
  const runStore = new RunStore({ storagePath, idFactory: () => 'run-1' });
  const run = runStore.start(instruction, { prompt: 'guarded prompt' });
  runStore.transition(run.id, 'dialing');
  const mediaSessions = new Map([['valid-token', {
    provider: options.provider ?? 'twilio', runId: run.id, prompt: 'guarded prompt',
  }]]);
  const attached = [];
  const closed = [];
  const app = await buildMediaServer({
    config: {
      openaiApiKey: 'key', openaiModel: 'model', twilioAuthToken: 'twilio-secret',
      telnyxPublicKey: 'telnyx-public-key',
    },
    runStore,
    mediaSessions,
    tunnel: {
      mediaWebSocketUrl: (token) => `wss://calls.example/media-stream/${token}`,
      callbackUrl: (path) => `https://calls.example/${path}`,
    },
    publish: () => {},
    validateTwilioRequest: () => true,
    validateTelnyxRequest: options.validateTelnyxRequest ?? (() => true),
    realtimeCallFactory: ({ runId }) => ({
      async attach(socket) { attached.push({ runId, socket }); },
      async close() { closed.push(runId); },
      async fail(error) { closed.push(`${runId}:${error.message}`); },
    }),
  });
  await app.ready();
  return { app, attached, closed, mediaSessions, runStore, storagePath };
}

test('accepts a tokenized Telnyx media websocket and adapts its start frame', async () => {
  const state = await setup({ provider: 'telnyx' });
  let socket;
  try {
    socket = await state.app.injectWS('/media-stream/valid-token');
    await new Promise((resolve) => setImmediate(resolve));
    const adapted = state.attached[0].socket;
    const message = new Promise((resolve) => adapted.addEventListener('message', resolve));
    socket.send(JSON.stringify({
      event: 'start', stream_id: 'stream-1', start: { stream_id: 'stream-1' },
    }));
    assert.equal(JSON.parse((await message).data).start.streamSid, 'stream-1');
  } finally {
    socket?.terminate();
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});

test('authenticates Telnyx call events and closes the matching media session on hangup', async () => {
  const validations = [];
  const state = await setup({
    provider: 'telnyx',
    validateTelnyxRequest(input) { validations.push(input); return true; },
  });
  try {
    const body = {
      data: {
        event_type: 'call.answered',
        payload: {
          call_control_id: 'v3:call-id',
          client_state: Buffer.from(JSON.stringify({ token: 'valid-token' })).toString('base64'),
          hangup_cause: 'normal_clearing',
        },
      },
    };
    const response = await state.app.inject({
      method: 'POST',
      url: '/telnyx/webhook',
      headers: {
        'content-type': 'application/json',
        'telnyx-signature-ed25519': 'signature',
        'telnyx-timestamp': '1700000000',
      },
      payload: JSON.stringify(body),
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(state.runStore.getRun('run-1').status, 'connected');
    body.data.event_type = 'call.hangup';
    const hangup = await state.app.inject({
      method: 'POST',
      url: '/telnyx/webhook',
      headers: {
        'content-type': 'application/json',
        'telnyx-signature-ed25519': 'signature',
        'telnyx-timestamp': '1700000000',
      },
      payload: JSON.stringify(body),
    });
    assert.equal(hangup.statusCode, 200, hangup.body);
    assert.equal(validations.length, 2);
    assert.equal(validations[0].publicKey, 'telnyx-public-key');
    assert.equal(validations[1].rawBody.toString(), JSON.stringify(body));
    assert.equal(state.mediaSessions.has('valid-token'), false);
    assert.match(state.runStore.getRun('run-1').summary, /ended.*before realtime media/i);
  } finally {
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});

test('rejects an invalid Telnyx webhook signature', async () => {
  const state = await setup({ provider: 'telnyx', validateTelnyxRequest: () => false });
  try {
    const response = await state.app.inject({
      method: 'POST', url: '/telnyx/webhook',
      headers: {
        'content-type': 'application/json',
        'telnyx-signature-ed25519': 'bad',
        'telnyx-timestamp': '1700000000',
      },
      payload: JSON.stringify({ data: { event_type: 'call.hangup', payload: {} } }),
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});

test('accepts a registered media websocket and binds it to the run', async () => {
  const state = await setup();
  try {
    const socket = await state.app.injectWS('/media-stream/valid-token', {
      headers: { 'x-twilio-signature': 'valid' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.attached.length, 1);
    assert.equal(state.attached[0].runId, 'run-1');
    assert.equal(state.mediaSessions.get('valid-token').realtimeCall !== undefined, true);
    socket.terminate();
  } finally {
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});

test('rejects an unknown media token', async () => {
  const state = await setup();
  try {
    await assert.rejects(
      () => state.app.injectWS('/media-stream/wrong-token', { headers: { 'x-twilio-signature': 'valid' } }),
      /Unexpected server response: 404/,
    );
    assert.equal(state.attached.length, 0);
  } finally {
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});

test('closes the realtime session when Twilio reports the call completed', async () => {
  const state = await setup();
  try {
    const socket = await state.app.injectWS('/media-stream/valid-token', {
      headers: { 'x-twilio-signature': 'valid' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const response = await state.app.inject({
      method: 'POST',
      url: '/twilio/status/valid-token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'valid',
      },
      payload: 'CallStatus=completed&CallSid=CA123',
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(state.closed, ['run-1']);
    assert.equal(state.mediaSessions.has('valid-token'), false);
    socket.terminate();
  } finally {
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});

test('fails and cleans up the media session for an abnormal terminal Twilio status', async () => {
  const state = await setup();
  let socket;
  try {
    socket = await state.app.injectWS('/media-stream/valid-token', {
      headers: { 'x-twilio-signature': 'valid' },
    });
    const response = await state.app.inject({
      method: 'POST',
      url: '/twilio/status/valid-token',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'valid',
      },
      payload: 'CallStatus=busy&CallSid=CA123',
    });

    assert.equal(response.statusCode, 204);
    assert.deepEqual(state.closed, ['run-1:Twilio call ended with status busy']);
    assert.equal(state.mediaSessions.has('valid-token'), false);
  } finally {
    socket?.terminate();
    await state.app.close();
    await rm(state.storagePath, { recursive: true, force: true });
  }
});
