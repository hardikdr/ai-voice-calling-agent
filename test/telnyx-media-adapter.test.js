import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { TelnyxMediaAdapter } from '../src/telnyx-media-adapter.js';

class FakeSocket extends EventEmitter {
  sent = [];
  send(message) { this.sent.push(JSON.parse(message)); }
}

test('translates Telnyx start frames into the shape expected by the OpenAI Twilio transport', () => {
  const socket = new FakeSocket();
  const adapter = new TelnyxMediaAdapter(socket);
  let received;
  adapter.addEventListener('message', (event) => { received = JSON.parse(event.data); });

  socket.emit('message', JSON.stringify({
    event: 'start', stream_id: 'stream-1', start: { stream_id: 'stream-1', media_format: { encoding: 'PCMU' } },
  }));

  assert.equal(received.start.streamSid, 'stream-1');
});

test('removes Twilio-only streamSid fields from outbound Telnyx media commands', () => {
  const socket = new FakeSocket();
  const adapter = new TelnyxMediaAdapter(socket);

  adapter.send(JSON.stringify({ event: 'media', streamSid: 'stream-1', media: { payload: 'AQID' } }));
  adapter.send(JSON.stringify({ event: 'mark', streamSid: 'stream-1', mark: { name: 'item:160' } }));
  adapter.send(JSON.stringify({ event: 'clear', streamSid: 'stream-1' }));

  assert.deepEqual(socket.sent, [
    { event: 'media', media: { payload: 'AQID' } },
    { event: 'mark', mark: { name: 'item:160' } },
    { event: 'clear' },
  ]);
});

test('forwards close and error events from the Telnyx socket', () => {
  const socket = new FakeSocket();
  const adapter = new TelnyxMediaAdapter(socket);
  const events = [];
  adapter.addEventListener('close', () => events.push('close'));
  adapter.addEventListener('error', () => events.push('error'));

  socket.emit('error', new Error('network'));
  socket.emit('close');

  assert.deepEqual(events, ['error', 'close']);
});
