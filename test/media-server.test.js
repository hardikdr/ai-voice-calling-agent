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

async function setup() {
  const storagePath = await mkdtemp(join(tmpdir(), 'calling-agent-media-'));
  const runStore = new RunStore({ storagePath, idFactory: () => 'run-1' });
  const run = runStore.start(instruction, { prompt: 'guarded prompt' });
  runStore.transition(run.id, 'dialing');
  const mediaSessions = new Map([['valid-token', { runId: run.id, prompt: 'guarded prompt' }]]);
  const attached = [];
  const closed = [];
  const app = await buildMediaServer({
    config: { openaiApiKey: 'key', openaiModel: 'model', twilioAuthToken: 'twilio-secret' },
    runStore,
    mediaSessions,
    tunnel: {
      mediaWebSocketUrl: (token) => `wss://calls.example/media-stream/${token}`,
      callbackUrl: (path) => `https://calls.example/${path}`,
    },
    publish: () => {},
    validateTwilioRequest: () => true,
    realtimeCallFactory: ({ runId }) => ({
      async attach(socket) { attached.push({ runId, socket }); },
      async close() { closed.push(runId); },
      async fail(error) { closed.push(`${runId}:${error.message}`); },
    }),
  });
  await app.ready();
  return { app, attached, closed, mediaSessions, runStore, storagePath };
}

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
