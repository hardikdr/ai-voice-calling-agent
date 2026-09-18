import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer } from '../src/server.js';

const validDryInstruction = {
  phone_number: '+4930123456',
  language: 'de',
  my_name: 'Ada',
  objective: 'Ask for opening hours.',
  allowed_times: [],
  forbidden_times: [],
  facts_agent_may_disclose: [],
  actions_agent_may_take: ['ask questions'],
  actions_requiring_confirmation: [],
  dry_run: true,
};

async function withApp(run, options = {}) {
  const storagePath = await mkdtemp(join(tmpdir(), 'calling-agent-server-'));
  const app = await buildServer({
    config: {
      storagePath,
      maxCallSeconds: 600,
      openaiApiKey: undefined,
      twilioAccountSid: undefined,
      twilioAuthToken: undefined,
      twilioFromNumber: undefined,
      ...options.config,
    },
    dryRunDelayMs: options.dryRunDelayMs ?? 1,
    telephony: options.telephony,
  });
  try {
    await run(app);
  } finally {
    await app.close();
    await rm(storagePath, { recursive: true, force: true });
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

test('completes a dry-run lifecycle and exposes a safe run artifact', async () => {
  await withApp(async (app) => {
    const eventPromise = once(app.runEvents, 'state');
    const response = await app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: validDryInstruction,
    });

    assert.equal(response.statusCode, 202);
    const { runId } = response.json();
    await eventPromise;
    const run = await waitFor(() => {
      const candidate = app.runStore.getRun(runId);
      return candidate?.status === 'completed' ? candidate : null;
    });
    assert.equal(run.transcript.length, 2);
    assert.match(run.summary, /Dry run completed/);

    const artifact = await app.inject({ method: 'GET', url: `/api/calls/${runId}` });
    assert.equal(artifact.statusCode, 200);
    assert.doesNotMatch(artifact.body, /OPENAI_API_KEY|TWILIO_AUTH_TOKEN/);
  });
});

test('returns structured validation issues without starting a call', async () => {
  await withApp(async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/calls',
      payload: { ...validDryInstruction, phone_number: '030', surprise: true },
    });

    assert.equal(response.statusCode, 422);
    assert.deepEqual(response.json().issues.map((issue) => issue.path).sort(), [
      'phone_number',
      'surprise',
    ]);
    assert.equal(app.runStore.publicState().activeRun, null);
  });
});

test('rejects a second call while one is active', async () => {
  await withApp(async (app) => {
    const first = await app.inject({ method: 'POST', url: '/api/calls', payload: validDryInstruction });
    assert.equal(first.statusCode, 202);

    const second = await app.inject({ method: 'POST', url: '/api/calls', payload: validDryInstruction });
    assert.equal(second.statusCode, 409);
    assert.match(second.json().error, /already active/);
  }, { dryRunDelayMs: 100 });
});

test('cancels an active dry run', async () => {
  await withApp(async (app) => {
    const started = await app.inject({ method: 'POST', url: '/api/calls', payload: validDryInstruction });
    const { runId } = started.json();

    const response = await app.inject({ method: 'POST', url: `/api/calls/${runId}/hangup` });
    assert.equal(response.statusCode, 202);
    await waitFor(() => app.runStore.getRun(runId)?.status === 'cancelled');
    assert.equal(app.runStore.publicState().activeRun, null);
  }, { dryRunDelayMs: 100 });
});

test('reports process readiness without requiring real-call credentials', async () => {
  await withApp(async (app) => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      dryRunReady: true,
      realCallReady: false,
    });

    const state = await app.inject({ method: 'GET', url: '/api/state' });
    assert.deepEqual(state.json(), { activeRun: null, latestRun: null });
  });
});
