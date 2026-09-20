import test from 'node:test';
import assert from 'node:assert/strict';

import { TwilioTelephony } from '../src/telephony.js';

function fakeClient() {
  const calls = (sid) => ({
    update: async (payload) => {
      calls.updated.push({ sid, payload });
      return { sid, status: payload.status };
    },
  });
  calls.created = [];
  calls.updated = [];
  calls.create = async (payload) => {
    calls.created.push(payload);
    return { sid: 'CA123', status: 'queued' };
  };
  return { calls };
}

const tunnel = {
  mediaWebSocketUrl: (token) => `wss://media.example.test/media-stream/${token}`,
  callbackUrl: (path) => `https://media.example.test/${path}`,
};

const run = {
  id: 'run-1',
  instruction: { phone_number: '+4930123456' },
  providerCallId: 'CA123',
};

test('creates a non-recorded outbound call with tokenized stream and status URLs', async () => {
  const client = fakeClient();
  const mediaSessions = new Map();
  const telephony = new TwilioTelephony({
    accountSid: 'AC123',
    authToken: 'secret',
    fromNumber: '+4930999999',
    client,
    tunnel,
    mediaSessions,
    tokenFactory: () => 'media-token',
  });

  const result = await telephony.start({ run, prompt: 'guarded prompt' });

  assert.deepEqual(result, { providerCallId: 'CA123' });
  assert.equal(client.calls.created.length, 1);
  const { twiml, ...callOptions } = client.calls.created[0];
  assert.deepEqual(callOptions, {
    to: '+4930123456',
    from: '+4930999999',
    statusCallback: 'https://media.example.test/twilio/status/media-token',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    statusCallbackMethod: 'POST',
  });
  assert.match(twiml, /^<\?xml[^>]+><Response><Connect><Stream url="wss:\/\/media\.example\.test\/media-stream\/media-token"\s*\/><\/Connect><\/Response>$/);
  assert.equal('record' in client.calls.created[0], false);
  assert.deepEqual(mediaSessions.get('media-token'), {
    provider: 'twilio',
    runId: 'run-1',
    prompt: 'guarded prompt',
  });
});

test('hangs up the exact provider call associated with the run', async () => {
  const client = fakeClient();
  const telephony = new TwilioTelephony({
    accountSid: 'AC123', authToken: 'secret', fromNumber: '+4930999999',
    client, tunnel, mediaSessions: new Map(), tokenFactory: () => 'token',
  });

  await telephony.hangup(run);

  assert.deepEqual(client.calls.updated, [{ sid: 'CA123', payload: { status: 'completed' } }]);
});

test('fails before dialing when credentials are incomplete', async () => {
  const client = fakeClient();
  const telephony = new TwilioTelephony({
    accountSid: undefined,
    authToken: 'secret',
    fromNumber: '+4930999999',
    client,
    tunnel,
    mediaSessions: new Map(),
  });

  await assert.rejects(() => telephony.start({ run, prompt: 'prompt' }), /credentials are incomplete/);
  assert.equal(client.calls.created.length, 0);
});
