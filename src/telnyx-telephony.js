import { randomBytes } from 'node:crypto';

const API_ROOT = 'https://api.telnyx.com/v2';

export class TelnyxTelephony {
  #apiKey;
  #connectionId;
  #fromNumber;
  #fetch;
  #tunnel;
  #mediaSessions;
  #tokenFactory;

  constructor({
    apiKey,
    connectionId,
    fromNumber,
    fetch = globalThis.fetch,
    tunnel,
    mediaSessions,
    tokenFactory = () => randomBytes(32).toString('base64url'),
  }) {
    this.#apiKey = apiKey;
    this.#connectionId = connectionId;
    this.#fromNumber = fromNumber;
    this.#fetch = fetch;
    this.#tunnel = tunnel;
    this.#mediaSessions = mediaSessions;
    this.#tokenFactory = tokenFactory;
  }

  get ready() {
    return Boolean(
      this.#apiKey
        && this.#connectionId
        && this.#fromNumber
        && this.#tunnel?.ready,
    );
  }

  async start({ run, prompt }) {
    this.#assertReady();
    const token = this.#tokenFactory();
    const streamUrl = this.#tunnel.mediaWebSocketUrl(token);
    const webhookUrl = this.#tunnel.callbackUrl('telnyx/webhook');
    this.#mediaSessions.set(token, { provider: 'telnyx', runId: run.id, prompt });

    try {
      const data = await this.#request('/calls', {
        connection_id: this.#connectionId,
        to: run.instruction.phone_number,
        from: this.#fromNumber,
        stream_url: streamUrl,
        webhook_url: webhookUrl,
        stream_track: 'inbound_track',
        stream_codec: 'PCMU',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMU',
        stream_bidirectional_sampling_rate: 8000,
        stream_bidirectional_target_legs: 'self',
        client_state: Buffer.from(JSON.stringify({ token })).toString('base64'),
      });
      const providerCallId = data?.call_control_id;
      if (!providerCallId) throw new Error('Telnyx did not return a call_control_id');
      this.#mediaSessions.get(token).providerCallId = providerCallId;
      return { providerCallId };
    } catch (error) {
      this.#mediaSessions.delete(token);
      throw error;
    }
  }

  async hangup(run) {
    if (!run.providerCallId) return;
    this.#assertReady();
    await this.#request(`/calls/${encodeURIComponent(run.providerCallId)}/actions/hangup`, {});
  }

  #assertReady() {
    if (!this.#apiKey || !this.#connectionId || !this.#fromNumber) {
      throw new Error('Telnyx credentials are incomplete');
    }
    if (!this.#tunnel?.ready && this.#tunnel?.ready !== undefined) {
      throw new Error('Public media tunnel is not ready');
    }
  }

  async #request(path, body) {
    const response = await this.#fetch(`${API_ROOT}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text();
      let message = detail;
      try {
        const parsed = JSON.parse(detail);
        message = parsed.errors?.map((error) => error.detail ?? error.title).filter(Boolean).join('; ') || detail;
      } catch {}
      throw new Error(`Telnyx API request failed (${response.status}): ${message}`);
    }
    const payload = await response.json();
    return payload.data;
  }
}
