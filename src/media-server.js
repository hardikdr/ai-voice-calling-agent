import Fastify from 'fastify';
import fastifyFormBody from '@fastify/formbody';
import fastifyWebsocket from '@fastify/websocket';
import twilio from 'twilio';

import { RealtimeCall } from './realtime-call.js';

const terminalTwilioStatuses = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled']);
const terminalRunStatuses = new Set(['completed', 'failed', 'cancelled']);

export async function buildMediaServer({
  config,
  runStore,
  mediaSessions,
  tunnel,
  publish,
  validateTwilioRequest = twilio.validateRequest,
  realtimeCallFactory = (options) => new RealtimeCall(options),
}) {
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);
  await app.register(fastifyFormBody);

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
      const signature = request.headers['x-twilio-signature'];
      const url = tunnel.mediaWebSocketUrl(request.params.token);
      if (!authorize(signature, url, {})) {
        return reply.code(403).send({ error: 'Invalid Twilio signature' });
      }
    },
  }, (socket, request) => {
    const entry = mediaSessions.get(request.params.token);
    if (!entry) return socket.close(1008, 'Unknown media session');
    const realtimeCall = realtimeCallFactory({
      apiKey: config.openaiApiKey,
      model: config.openaiModel,
      runStore,
      runId: entry.runId,
      prompt: entry.prompt,
      onChange: publish,
    });
    entry.realtimeCall = realtimeCall;
    void realtimeCall.attach(socket).catch(() => socket.close(1011, 'Realtime connection failed'));
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
