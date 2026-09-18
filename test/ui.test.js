import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer } from '../src/server.js';
import { deriveControls, formatValidationIssues } from '../public/app.js';

async function withApp(run) {
  const storagePath = await mkdtemp(join(tmpdir(), 'calling-agent-ui-'));
  const app = await buildServer({ config: { storagePath } });
  try {
    await run(app);
  } finally {
    await app.close();
    await rm(storagePath, { recursive: true, force: true });
  }
}

test('serves the local control panel and its browser assets', async () => {
  await withApp(async (app) => {
    const page = await app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    for (const id of [
      'instruction', 'start-call', 'end-call', 'status', 'transcript', 'summary', 'download-run',
    ]) {
      assert.match(page.body, new RegExp(`id="${id}"`));
    }

    const script = await app.inject({ method: 'GET', url: '/app.js' });
    assert.equal(script.statusCode, 200);
    assert.match(script.headers['content-type'], /javascript/);
  });
});

test('derives safe call controls from lifecycle state', () => {
  assert.deepEqual(deriveControls({ activeRun: null, latestRun: null }), {
    canStart: true,
    canEnd: false,
    canDownload: false,
  });
  assert.deepEqual(deriveControls({
    activeRun: { id: 'run-1', status: 'connected' },
    latestRun: { id: 'run-1', status: 'connected' },
  }), {
    canStart: false,
    canEnd: true,
    canDownload: false,
  });
  assert.deepEqual(deriveControls({
    activeRun: null,
    latestRun: { id: 'run-1', status: 'completed' },
  }), {
    canStart: true,
    canEnd: false,
    canDownload: true,
  });
});

test('formats server validation issues as plain text', () => {
  const text = formatValidationIssues([
    { path: 'phone_number', message: 'Must be E.164' },
    { path: 'objective', message: 'Required <script>alert(1)</script>' },
  ]);

  assert.equal(
    text,
    'phone_number: Must be E.164\nobjective: Required <script>alert(1)</script>',
  );
});
