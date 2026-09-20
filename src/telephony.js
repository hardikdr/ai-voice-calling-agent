import { randomBytes } from 'node:crypto';

import twilio from 'twilio';

export class TwilioTelephony {
  #accountSid;
  #authToken;
  #fromNumber;
  #client;
  #tunnel;
  #mediaSessions;
  #tokenFactory;

  constructor({
    accountSid,
    authToken,
    fromNumber,
    client,
    tunnel,
    mediaSessions,
    tokenFactory = () => randomBytes(32).toString('base64url'),
  }) {
    this.#accountSid = accountSid;
    this.#authToken = authToken;
    this.#fromNumber = fromNumber;
    this.#client = client;
    this.#tunnel = tunnel;
    this.#mediaSessions = mediaSessions;
    this.#tokenFactory = tokenFactory;
  }

  get ready() {
    return Boolean(this.#accountSid && this.#authToken && this.#fromNumber && this.#tunnel?.ready);
  }

  async start({ run, prompt }) {
    this.#assertReady();
    const token = this.#tokenFactory();
    const streamUrl = this.#tunnel.mediaWebSocketUrl(token);
    const statusCallback = this.#tunnel.callbackUrl(`twilio/status/${token}`);
    const response = new twilio.twiml.VoiceResponse();
    response.connect().stream({ url: streamUrl });
    this.#mediaSessions.set(token, { provider: 'twilio', runId: run.id, prompt });

    try {
      const call = await this.#twilioClient().calls.create({
        to: run.instruction.phone_number,
        from: this.#fromNumber,
        twiml: response.toString(),
        statusCallback,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
      });
      return { providerCallId: call.sid };
    } catch (error) {
      this.#mediaSessions.delete(token);
      throw error;
    }
  }

  async hangup(run) {
    if (!run.providerCallId) return;
    this.#assertReady();
    await this.#twilioClient().calls(run.providerCallId).update({ status: 'completed' });
  }

  #assertReady() {
    if (!this.#accountSid || !this.#authToken || !this.#fromNumber) {
      throw new Error('Twilio credentials are incomplete');
    }
    if (!this.#tunnel?.ready && this.#tunnel?.ready !== undefined) {
      throw new Error('Public media tunnel is not ready');
    }
  }

  #twilioClient() {
    if (!this.#client) this.#client = twilio(this.#accountSid, this.#authToken);
    return this.#client;
  }
}
