import { spawn } from 'node:child_process';

const quickTunnelPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

export class TunnelManager {
  #mediaPort;
  #publicMediaUrl;
  #spawn;
  #timeoutMs;
  #child = null;
  #url = null;

  constructor({
    mediaPort,
    publicMediaUrl,
    spawnProcess = spawn,
    timeoutMs = 30_000,
  }) {
    this.#mediaPort = mediaPort;
    this.#publicMediaUrl = publicMediaUrl;
    this.#spawn = spawnProcess;
    this.#timeoutMs = timeoutMs;
  }

  get ready() {
    return Boolean(this.#url);
  }

  async start() {
    if (this.#url) return this.#url;
    if (this.#publicMediaUrl) {
      this.#url = normalizeHttpsUrl(this.#publicMediaUrl);
      return this.#url;
    }

    const child = this.#spawn('cloudflared', [
      'tunnel',
      '--url',
      `http://127.0.0.1:${this.#mediaPort}`,
      '--no-autoupdate',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    this.#child = child;

    try {
      this.#url = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (action, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          action(value);
        };
        const consume = (chunk) => {
          const match = String(chunk).match(quickTunnelPattern);
          if (match) finish(resolve, normalizeHttpsUrl(match[0]));
        };
        const timer = setTimeout(() => {
          finish(reject, new Error('Timed out waiting for the Cloudflare tunnel URL'));
          child.kill('SIGTERM');
        }, this.#timeoutMs);

        child.stdout?.on('data', consume);
        child.stderr?.on('data', consume);
        child.once('error', (error) => finish(reject, error));
        child.once('exit', (code) => {
          finish(reject, new Error(`cloudflared exited before publishing a URL (code ${code})`));
        });
      });
      return this.#url;
    } catch (error) {
      this.#url = null;
      this.#child = null;
      throw error;
    }
  }

  mediaWebSocketUrl(token) {
    if (!this.#url) throw new Error('Media tunnel is not ready');
    const mediaUrl = this.#resolvePath(`media-stream/${encodeURIComponent(token)}`);
    mediaUrl.protocol = 'wss:';
    return mediaUrl.href;
  }

  callbackUrl(path) {
    if (!this.#url) throw new Error('Media tunnel is not ready');
    const encodedPath = String(path).split('/').map(encodeURIComponent).join('/');
    return this.#resolvePath(encodedPath).href;
  }

  async stop() {
    const child = this.#child;
    this.#child = null;
    this.#url = null;
    if (!child || child.killed) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(resolve, 1_000).unref();
    });
  }

  #resolvePath(path) {
    return new URL(path, this.#url);
  }
}

function normalizeHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('PUBLIC_MEDIA_URL must use HTTPS');
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url;
}
