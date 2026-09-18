import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActiveCallError, RunStore } from '../src/run-store.js';

const instruction = {
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

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'calling-agent-store-'));
  let tick = 0;
  const store = new RunStore({
    storagePath: directory,
    clock: () => new Date(1_750_000_000_000 + tick++ * 1_000),
    idFactory: () => 'run-1',
  });
  try {
    await run({ store, directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('enforces legal transitions and only one active call', async () => {
  await withStore(async ({ store }) => {
    const run = store.start(instruction);
    assert.equal(run.status, 'validating');
    assert.throws(() => store.start(instruction), ActiveCallError);

    store.transition(run.id, 'dialing');
    store.transition(run.id, 'connected');
    await store.finish(run.id, { status: 'completed', summary: 'Hours received.' });

    assert.equal(store.getRun(run.id).status, 'completed');
    assert.doesNotThrow(() => store.start(instruction));
  });
});

test('rejects an impossible lifecycle transition', async () => {
  await withStore(async ({ store }) => {
    const run = store.start(instruction);
    assert.throws(() => store.transition(run.id, 'connected'), /validating.*connected/);
  });
});

test('persists transcript-only public artifacts without private values', async () => {
  await withStore(async ({ store, directory }) => {
    const run = store.start(instruction, {
      prompt: 'private prompt',
      mediaToken: 'private media token',
      providerClient: { secret: 'private client' },
    });
    store.transition(run.id, 'dialing');
    store.transition(run.id, 'connected');
    store.appendTranscript(run.id, 'assistant', 'Ich bin eine digitale Assistenz.');
    store.appendTranscript(run.id, 'human', 'Wir öffnen um acht Uhr.');
    await store.finish(run.id, { status: 'completed', summary: 'Opens at 08:00.' });

    const artifact = JSON.parse(await readFile(join(directory, 'run-1.json'), 'utf8'));
    assert.deepEqual(artifact.transcript.map(({ speaker, text }) => ({ speaker, text })), [
      { speaker: 'assistant', text: 'Ich bin eine digitale Assistenz.' },
      { speaker: 'human', text: 'Wir öffnen um acht Uhr.' },
    ]);
    const serialized = JSON.stringify(artifact);
    assert.doesNotMatch(serialized, /private prompt|private media token|private client/);
    assert.equal(artifact.instruction.phone_number, '+4930123456');
  });
});

test('cancels an active run and persists the reason', async () => {
  await withStore(async ({ store }) => {
    const run = store.start(instruction);
    store.transition(run.id, 'dialing');
    await store.cancel(run.id, 'Cancelled by user');

    assert.equal(store.getRun(run.id).status, 'cancelled');
    assert.equal(store.getRun(run.id).summary, 'Cancelled by user');
    assert.equal(store.publicState().activeRun, null);
  });
});
