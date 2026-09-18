import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { TunnelManager } from '../src/tunnel.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('exit', 0, 'SIGTERM');
  };
  return child;
}

test('extracts a quick-tunnel URL and creates a tokenized websocket URL', async () => {
  const child = fakeChild();
  const manager = new TunnelManager({
    mediaPort: 5050,
    spawnProcess: () => child,
    timeoutMs: 100,
  });

  const started = manager.start();
  let settled = false;
  void started.then(() => { settled = true; });
  child.stderr.write('INF Requesting new quick Tunnel on https://api.trycloudflare.com\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.stderr.write('INF +https://violet-lake.trycloudflare.com ready\n');
  assert.equal((await started).href, 'https://violet-lake.trycloudflare.com/');
  assert.equal(
    manager.mediaWebSocketUrl('a token'),
    'wss://violet-lake.trycloudflare.com/media-stream/a%20token',
  );
  assert.equal(
    manager.callbackUrl('twilio/status/a token'),
    'https://violet-lake.trycloudflare.com/twilio/status/a%20token',
  );
  await manager.stop();
  assert.equal(child.killed, true);
});

test('uses a configured public URL without starting cloudflared', async () => {
  let spawnCount = 0;
  const manager = new TunnelManager({
    mediaPort: 5050,
    publicMediaUrl: 'https://calls.example.test/base/',
    spawnProcess: () => {
      spawnCount += 1;
      return fakeChild();
    },
  });

  assert.equal((await manager.start()).href, 'https://calls.example.test/base/');
  assert.equal(manager.mediaWebSocketUrl('token'), 'wss://calls.example.test/base/media-stream/token');
  assert.equal(spawnCount, 0);
});

test('rejects and cleans up when cloudflared exits before publishing a URL', async () => {
  const child = fakeChild();
  const manager = new TunnelManager({ mediaPort: 5050, spawnProcess: () => child, timeoutMs: 100 });

  const started = manager.start();
  child.stderr.write('failed to request quick Tunnel: unable to get local issuer certificate\n');
  child.emit('exit', 1, null);
  await assert.rejects(started, /exited before publishing.*unable to get local issuer certificate/s);
  assert.equal(manager.ready, false);
});

test('times out and terminates a stuck tunnel process', async () => {
  const child = fakeChild();
  const manager = new TunnelManager({ mediaPort: 5050, spawnProcess: () => child, timeoutMs: 5 });

  await assert.rejects(manager.start(), /Timed out/);
  assert.equal(child.killed, true);
});
