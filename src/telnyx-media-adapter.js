import { EventEmitter } from 'node:events';

export class TelnyxMediaAdapter extends EventEmitter {
  #socket;

  constructor(socket) {
    super();
    this.#socket = socket;
    const listen = typeof socket.addEventListener === 'function'
      ? (event, handler) => socket.addEventListener(event, handler)
      : (event, handler) => socket.on(event, handler);
    listen('message', (message) => this.#onMessage(message));
    listen('close', () => this.emit('close'));
    listen('error', (error) => this.emit('error', error));
  }

  addEventListener(event, handler) {
    this.on(event, handler);
  }

  send(message) {
    const data = JSON.parse(String(message));
    delete data.streamSid;
    this.#socket.send(JSON.stringify(data));
  }

  close(code, reason) {
    this.#socket.close?.(code, reason);
  }

  #onMessage(message) {
    const raw = message?.data ?? message;
    const data = JSON.parse(raw.toString());
    if (data.event === 'start') {
      data.start = {
        ...data.start,
        streamSid: data.start?.streamSid ?? data.start?.stream_id ?? data.stream_id,
      };
    }
    this.emit('message', { data: JSON.stringify(data) });
  }
}
