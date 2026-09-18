import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRuntime } from '../src/runtime.js';

test('shares run state across listeners and starts media before the public tunnel', async () => {
  const events = [];
  const apps = [];
  const makeApp = (name) => ({
    async listen(options) { events.push(`${name}:listen:${options.port}`); },
    async close() { events.push(`${name}:close`); },
  });
  const tunnel = {
    ready: false,
    async start() { events.push('tunnel:start'); this.ready = true; return new URL('https://calls.example/'); },
    async stop() { events.push('tunnel:stop'); this.ready = false; },
  };
  const received = {};
  const runtime = await buildRuntime({
    config: {
      storagePath: '/tmp/calling-agent-runtime-test', uiPort: 8080, mediaPort: 5050,
      maxCallSeconds: 600, openaiModel: 'model', openaiApiKey: undefined,
      twilioAccountSid: undefined, twilioAuthToken: undefined, twilioFromNumber: undefined,
    },
    createTunnel: () => tunnel,
    createTelephony: (options) => ({ options }),
    createMediaServer: async (options) => { received.media = options; const app = makeApp('media'); apps.push(app); return app; },
    createControlServer: async (options) => { received.control = options; const app = makeApp('control'); apps.push(app); return app; },
  });

  const result = await runtime.start();

  assert.equal(received.media.runStore, received.control.runStore);
  assert.equal(received.media.mediaSessions, received.control.telephony.options.mediaSessions);
  assert.deepEqual(events, ['media:listen:5050', 'control:listen:8080', 'tunnel:start']);
  assert.deepEqual(result, { tunnelReady: true, publicMediaUrl: 'https://calls.example/' });

  await runtime.stop();
  assert.deepEqual(events.slice(-3), ['control:close', 'media:close', 'tunnel:stop']);
});

test('keeps dry-run control available when the quick tunnel cannot start', async () => {
  const events = [];
  const tunnel = {
    ready: false,
    async start() { throw new Error('tunnel unavailable'); },
    async stop() { events.push('tunnel:stop'); },
  };
  const makeApp = (name) => ({
    async listen() { events.push(`${name}:listen`); },
    async close() { events.push(`${name}:close`); },
  });
  const runtime = await buildRuntime({
    config: {
      storagePath: '/tmp/calling-agent-runtime-test', uiPort: 8080, mediaPort: 5050,
      maxCallSeconds: 600, openaiModel: 'model',
    },
    createTunnel: () => tunnel,
    createTelephony: () => ({}),
    createMediaServer: async () => makeApp('media'),
    createControlServer: async () => makeApp('control'),
  });

  const result = await runtime.start();

  assert.equal(result.tunnelReady, false);
  assert.match(result.tunnelError.message, /unavailable/);
  assert.deepEqual(events, ['media:listen', 'control:listen']);
  await runtime.stop();
});
