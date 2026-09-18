import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { RealtimeCall } from '../src/realtime-call.js';

class FakeSession extends EventEmitter {
  constructor(agent, options) {
    super();
    this.agent = agent;
    this.options = options;
    this.messages = [];
    this.closed = false;
  }

  async connect(options) {
    this.connectOptions = options;
  }

  sendMessage(message) {
    this.messages.push(message);
  }

  close() {
    this.closed = true;
  }
}

function fakeSdk() {
  const created = { transports: [], agents: [], sessions: [] };
  return {
    created,
    createTransport(options) {
      const transport = { options };
      created.transports.push(transport);
      return transport;
    },
    createAgent(options) {
      const agent = { options };
      created.agents.push(agent);
      return agent;
    },
    createSession(agent, options) {
      const session = new FakeSession(agent, options);
      created.sessions.push(session);
      return session;
    },
  };
}

function fakeStore() {
  const run = {
    id: 'run-1',
    status: 'dialing',
    instruction: { my_name: 'Ada', language: 'de' },
    transcript: [],
  };
  return {
    run,
    transition(runId, status) {
      assert.equal(runId, run.id);
      run.status = status;
    },
    getRun: () => run,
    appendTranscript(runId, speaker, text) {
      assert.equal(runId, run.id);
      run.transcript.push({ speaker, text });
    },
    async finish(runId, result) {
      assert.equal(runId, run.id);
      Object.assign(run, result);
    },
  };
}

test('configures the official Twilio transport for guarded telephone audio', async () => {
  const sdk = fakeSdk();
  const store = fakeStore();
  const socket = new EventEmitter();
  const call = new RealtimeCall({
    apiKey: 'openai-key',
    model: 'gpt-realtime-2.1-mini',
    runStore: store,
    runId: 'run-1',
    prompt: 'guarded prompt',
    sdk,
  });

  await call.attach(socket);

  assert.equal(sdk.created.transports[0].options.twilioWebSocket, socket);
  assert.deepEqual(sdk.created.agents[0].options, {
    name: 'Personal calling agent',
    instructions: 'guarded prompt',
    voice: 'marin',
  });
  const session = sdk.created.sessions[0];
  assert.equal(session.options.transport, sdk.created.transports[0]);
  assert.equal(session.options.model, 'gpt-realtime-2.1-mini');
  assert.equal(session.options.historyStoreAudio, false);
  assert.equal(session.options.tracingDisabled, true);
  assert.deepEqual(session.options.config.audio.input.transcription, {
    model: 'gpt-4o-mini-transcribe',
    language: 'de',
  });
  assert.equal(session.options.config.audio.input.turnDetection.interruptResponse, true);
  assert.deepEqual(session.connectOptions, { apiKey: 'openai-key' });
  assert.match(session.messages[0], /Begin the call now.*AI or digital assistant/s);
  assert.equal(store.run.status, 'connected');
});

test('appends only completed user and assistant transcripts without duplicates', async () => {
  const sdk = fakeSdk();
  const store = fakeStore();
  const call = new RealtimeCall({
    apiKey: 'key', model: 'model', runStore: store, runId: 'run-1', prompt: 'prompt', sdk,
  });
  await call.attach(new EventEmitter());
  const session = sdk.created.sessions[0];
  const history = [
    {
      itemId: 'user-1', type: 'message', role: 'user', status: 'completed',
      content: [{ type: 'input_audio', transcript: 'Wir öffnen um acht.', audio: 'must-not-persist' }],
    },
    {
      itemId: 'assistant-1', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_audio', transcript: 'Vielen Dank.', audio: 'must-not-persist' }],
    },
    {
      itemId: 'assistant-2', type: 'message', role: 'assistant', status: 'in_progress',
      content: [{ type: 'output_audio', transcript: 'Partial', audio: 'must-not-persist' }],
    },
  ];

  session.emit('history_updated', history);
  session.emit('history_updated', history);

  assert.deepEqual(store.run.transcript, [
    { speaker: 'human', text: 'Wir öffnen um acht.' },
    { speaker: 'assistant', text: 'Vielen Dank.' },
  ]);
  assert.doesNotMatch(JSON.stringify(store.run.transcript), /must-not-persist|Partial/);
});

test('closes the realtime session and records a deterministic summary', async () => {
  const sdk = fakeSdk();
  const store = fakeStore();
  store.run.transcript.push({ speaker: 'human', text: 'Der Termin ist Montag.' });
  const call = new RealtimeCall({
    apiKey: 'key', model: 'model', runStore: store, runId: 'run-1', prompt: 'prompt', sdk,
  });
  await call.attach(new EventEmitter());

  await call.close();

  assert.equal(sdk.created.sessions[0].closed, true);
  assert.equal(store.run.status, 'completed');
  assert.match(store.run.summary, /Der Termin ist Montag/);
});

test('fails the run and closes the session when the provider ends abnormally', async () => {
  const sdk = fakeSdk();
  const store = fakeStore();
  const call = new RealtimeCall({
    apiKey: 'key', model: 'model', runStore: store, runId: 'run-1', prompt: 'prompt', sdk,
  });
  await call.attach(new EventEmitter());

  await call.fail(new Error('Twilio call ended with status busy'));

  assert.equal(sdk.created.sessions[0].closed, true);
  assert.equal(store.run.status, 'failed');
  assert.match(store.run.error, /status busy/);
});
