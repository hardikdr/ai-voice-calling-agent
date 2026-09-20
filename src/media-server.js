import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';
import twilio from 'twilio';

import { RealtimeCall } from './realtime-call.js';
import { TelnyxMediaAdapter } from './telnyx-media-adapter.js';
import { validateTelnyxWebhook } from './telnyx-webhook.js';

const terminalTwilioStatuses = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled']);

export async function buildMediaServer({
  config,
  runStore,
  mediaSessions,
  tunnel,
  publish,
  validateTwilioRequest = twilio.validateRequest,
  validateTelnyxRequest = validateTelnyxWebhook,
  realtimeCallFactory = (options) => new RealtimeCall(options),
}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(fastifyFormBody);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    request.rawBody = body;
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (error) {
      done(error);
    }
  });

  const authorize = (signature, url, params) => Boolean(
    signature
      && config.twilioAuthToken
      && validateTwilioRequest(config.twilioAuthToken, signature, url, params),
  );

  app.get('/media-stream/:token', {
    websocket: true,
    preValidation: async (request, reply) => {
      const entry = mediaSessions.get(request.params.token);
      if (!entry) return reply.code(404).send({ error: 'Unknown media session' });
      if (entry.provider === 'telnyx') return;
      const signature = request.headers['x-twilio-signature'];
      const url = tunnel.mediaWebSocketUrl(request.params.token);
      if (!authorize(signature, url, {})) {
        return reply.code(403).send({ error: 'Invalid Twilio signature' });
      }
    },
  }, (socket, request) => {
    const entry = mediaSessions.get(request.params.token);
    if (!entry) return socket.close(1008, 'Unknown media session');
    const providerSocket = entry.provider === 'telnyx' ? new TelnyxMediaAdapter(socket) : socket;
    const realtimeCall = realtimeCallFactory({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      runStore,
      runId: entry.runId,
      prompt: entry.prompt,
      onChange: publish,
    });
    entry.realtimeCall = realtimeCall;
    void realtimeCall.attach(providerSocket).catch(() => socket.close(1011, 'Realtime connection failed'));
  });

  app.post('/telnyx/webhook', async (request, reply) => {
    const valid = validateTelnyxRequest({
      publicKey: config.telnyxPublicKey,
      signature: request.headers['telnyx-signature-ed25519'],
      timestamp: request.headers['telnyx-timestamp'],
      rawBody: request.rawBody,
    });
    if (!valid) return reply.code(403).send({ error: 'Invalid Telnyx signature' });

    const event = request.body?.data;
    const token = decodeClientState(event?.payload?.client_state)?.token;
    const entry = token ? mediaSessions.get(token) : undefined;
    if (!entry || entry.provider !== 'telnyx') return reply.code(200).send({ ok: true });

    if (event.event_type === 'call.answered') {
      const run = runStore.getRun(entry.runId);
      if (run?.status === 'dialing') {
        runStore.transition(entry.runId, 'connected');
        publish();
      }
    } else if (event.event_type === 'call.hangup') {
      const cause = event.payload?.hangup_cause ?? 'unknown';
      const run = runStore.getRun(entry.runId);
      if (cause === 'normal_clearing') {
        if (entry.realtimeCall) {
          await entry.realtimeCall.close();
        } else if (run && !terminalRunStatuses.has(run.status)) {
          await runStore.finish(entry.runId, {
            status: 'completed',
            summary: 'The provider ended the call before realtime media connected.',
          });
          publish();
        }
      } else if (entry.realtimeCall) {
        await entry.realtimeCall.fail(new Error(`Telnyx call ended with cause ${cause}`));
      } else if (run && !terminalRunStatuses.has(run.status)) {
        await runStore.finish(entry.runId, {
          status: 'failed',
          summary: 'The phone call did not connect.',
          error: `Telnyx call ended with cause ${cause}`,
        });
        publish();
      }
      mediaSessions.delete(token);
    } else if (event.event_type === 'streaming.failed') {
      const error = new Error('Telnyx media streaming failed');
      if (entry.realtimeCall) await entry.realtimeCall.fail(error);
      mediaSessions.delete(token);
    }
    return reply.code(200).send({ ok: true });
  });

  app.post('/twilio/status/:token', async (request, reply) => {
    const entry = mediaSessions.get(request.params.token);
    if (!entry) return reply.code(404).send({ error: 'Unknown media session' });
    const signature = request.headers['x-twilio-signature'];
    const url = tunnel.callbackUrl(`twilio/status/${request.params.token}`);
    if (!authorize(signature, url, request.body ?? {})) {
      return reply.code(403).send({ error: 'Invalid Twilio signature' });
    }

    const callStatus = request.body.CallStatus;
    if (terminalTwilioStatuses.has(callStatus)) {
      const run = runStore.getRun(entry.runId);
      if (callStatus === 'completed') {
        if (entry.realtimeCall) {
          await entry.realtimeCall.close();
        } else if (run && !terminalRunStatuses.has(run.status)) {
          await runStore.finish(entry.runId, {
            status: 'completed',
            summary: 'The provider ended the call before realtime media connected.',
          });
          publish();
        }
      } else if (entry.realtimeCall) {
        await entry.realtimeCall.fail(new Error(`Twilio call ended with status ${callStatus}`));
      } else if (run && !terminalRunStatuses.has(run.status)) {
        await runStore.finish(entry.runId, {
          status: 'failed',
          summary: 'The phone call did not connect.',
          error: `Twilio call ended with status ${callStatus}`,
        });
        publish();
      }
      mediaSessions.delete(request.params.token);
    }
    return reply.code(204).send();
  });

  app.get('/healthz', async () => ({ ok: true }));
  return app;
}

function decodeClientState(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}
