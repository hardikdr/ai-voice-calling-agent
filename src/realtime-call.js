import { RealtimeAgent, RealtimeSession } from '@openai/agents/realtime';
import { TwilioRealtimeTransportLayer } from '@openai/agents-extensions';

const defaultSdk = {
  createTransport: (options) => new TwilioRealtimeTransportLayer(options),
  createAgent: (options) => new RealtimeAgent(options),
  createSession: (agent, options) => new RealtimeSession(agent, options),
};

const terminalStates = new Set(['completed', 'failed', 'cancelled']);

export class RealtimeCall {
  #apiKey;
  #model;
  #runStore;
  #runId;
  #prompt;
  #sdk;
  #onChange;
  #session = null;
  #seenTranscript = new Set();
  #closing = false;

  constructor({ apiKey, model, runStore, runId, prompt, sdk = defaultSdk, onChange = () => {} }) {
    this.#apiKey = apiKey;
    this.#model = model;
    this.#runStore = runStore;
    this.#runId = runId;
    this.#prompt = prompt;
    this.#sdk = sdk;
    this.#onChange = onChange;
  }

  async attach(twilioSocket) {
    const run = this.#runStore.getRun(this.#runId);
    if (!run) throw new Error(`Unknown run: ${this.#runId}`);
    if (!this.#apiKey) throw new Error('OpenAI API key is missing');

    const transport = this.#sdk.createTransport({ twilioWebSocket: twilioSocket });
    const agent = this.#sdk.createAgent({
      name: 'Personal calling agent',
      instructions: this.#prompt,
      voice: 'marin',
    });
    const transcription = { model: 'gpt-4o-mini-transcribe' };
    if (run.instruction.language !== 'auto') transcription.language = run.instruction.language;
    const session = this.#sdk.createSession(agent, {
      transport,
      model: this.#model,
      historyStoreAudio: false,
      tracingDisabled: true,
      config: {
        outputModalities: ['audio'],
        audio: {
          input: {
            transcription,
            noiseReduction: { type: 'far_field' },
            turnDetection: {
              type: 'server_vad',
              createResponse: true,
              interruptResponse: true,
              prefixPaddingMs: 300,
              silenceDurationMs: 500,
            },
          },
          output: { voice: 'marin' },
        },
      },
    });
    this.#session = session;
    session.on('history_updated', (history) => this.#captureTranscript(history));
    session.on('error', ({ error }) => void this.#fail(error));
    this.#listenForSocketClose(twilioSocket);

    try {
      await session.connect({ apiKey: this.#apiKey });
      const current = this.#runStore.getRun(this.#runId);
      if (current?.status === 'dialing') this.#runStore.transition(this.#runId, 'connected');
      this.#onChange();
      session.sendMessage(
        'Begin the call now. Your first spoken sentence must transparently identify you as an AI or digital assistant calling on the user\'s behalf.',
      );
    } catch (error) {
      await this.#fail(error);
      throw error;
    }
  }

  async close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#session?.close();
    const run = this.#runStore.getRun(this.#runId);
    if (run && !terminalStates.has(run.status)) {
      await this.#runStore.finish(this.#runId, {
        status: 'completed',
        summary: summarize(run.transcript),
      });
      this.#onChange();
    }
  }

  async fail(error) {
    await this.#fail(error);
  }

  #listenForSocketClose(socket) {
    const close = () => void this.close();
    if (typeof socket.once === 'function') socket.once('close', close);
    else if (typeof socket.addEventListener === 'function') socket.addEventListener('close', close, { once: true });
  }

  #captureTranscript(history) {
    for (const item of history) {
      if (item.type !== 'message' || item.status !== 'completed') continue;
      const speaker = item.role === 'user' ? 'human' : item.role === 'assistant' ? 'assistant' : null;
      if (!speaker) continue;
      item.content.forEach((content, index) => {
        const text = content.transcript ?? content.text;
        const key = `${item.itemId}:${index}`;
        if (!text?.trim() || this.#seenTranscript.has(key)) return;
        this.#seenTranscript.add(key);
        this.#runStore.appendTranscript(this.#runId, speaker, text);
        this.#onChange();
      });
    }
  }

  async #fail(error) {
    if (this.#closing) return;
    this.#closing = true;
    this.#session?.close();
    const run = this.#runStore.getRun(this.#runId);
    if (run && !terminalStates.has(run.status)) {
      await this.#runStore.finish(this.#runId, {
        status: 'failed',
        summary: 'The realtime conversation ended because of an error.',
        error: error instanceof Error ? error.message : String(error),
      });
      this.#onChange();
    }
  }
}

function summarize(transcript) {
  if (transcript.length === 0) return 'The call ended without a completed transcript.';
  const recent = transcript.slice(-4).map(({ speaker, text }) => `${speaker}: ${text}`).join(' ');
  return `Call ended. Recent transcript: ${recent}`;
}
