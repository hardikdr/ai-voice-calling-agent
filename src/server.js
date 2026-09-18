import { EventEmitter } from 'node:events';

import Fastify from 'fastify';

import { ActiveCallError, RunStore } from './run-store.js';
import { ValidationError, validateCallInstruction } from './call-instruction.js';
import { buildAgentPrompt } from './prompt.js';
import { runDryCall } from './dry-run.js';

export async function buildServer({ config, telephony, dryRunDelayMs = 150 }) {
  const app = Fastify({ logger: false });
  const runStore = new RunStore({ storagePath: config.storagePath });
  const runEvents = new EventEmitter();
  runEvents.setMaxListeners(100);
  const controllers = new Map();

  app.runStore = runStore;
  app.runEvents = runEvents;

  const publish = () => runEvents.emit('state', runStore.publicState());
  const hasCredentials = () => Boolean(
    config.openaiApiKey
      && config.twilioAccountSid
      && config.twilioAuthToken
      && config.twilioFromNumber,
  );

  app.get('/healthz', async () => ({
    ok: true,
    dryRunReady: true,
    realCallReady: hasCredentials() && Boolean(telephony),
  }));

  app.get('/api/state', async () => runStore.publicState());

  app.get('/api/calls/:runId', async (request, reply) => {
    const run = runStore.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return run;
  });

  app.post('/api/calls', async (request, reply) => {
    let instruction;
    try {
      instruction = validateCallInstruction(request.body);
    } catch (error) {
      if (error instanceof ValidationError) {
        return reply.code(422).send({ error: error.message, issues: error.issues });
      }
      throw error;
    }

    if (!instruction.dry_run && (!hasCredentials() || !telephony)) {
      return reply.code(503).send({
        error: 'Real calls require configured OpenAI and Twilio credentials',
      });
    }

    let run;
    try {
      run = runStore.start(instruction, { prompt: buildAgentPrompt(instruction) });
    } catch (error) {
      if (error instanceof ActiveCallError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
    publish();

    const controller = new AbortController();
    controllers.set(run.id, controller);
    const operation = instruction.dry_run
      ? runDryCall({
        runStore,
        runId: run.id,
        signal: controller.signal,
        delayMs: dryRunDelayMs,
        onChange: publish,
      })
      : startRealCall({ telephony, runStore, run, publish });

    operation.finally(() => controllers.delete(run.id));
    return reply.code(202).send({ runId: run.id });
  });

  app.post('/api/calls/:runId/hangup', async (request, reply) => {
    const run = runStore.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return reply.code(409).send({ error: 'Run is already finished' });
    }

    controllers.get(run.id)?.abort();
    if (!run.instruction.dry_run && telephony) await telephony.hangup(run);
    await runStore.cancel(run.id, 'Cancelled by user');
    publish();
    return reply.code(202).send({ runId: run.id, status: 'cancelled' });
  });

  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const send = (state) => reply.raw.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    send(runStore.publicState());
    runEvents.on('state', send);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      runEvents.off('state', send);
    });
  });

  app.addHook('onClose', async () => {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
  });

  return app;
}

async function startRealCall({ telephony, runStore, run, publish }) {
  try {
    runStore.transition(run.id, 'dialing');
    publish();
    const result = await telephony.start({
      run,
      prompt: runStore.getPrivate(run.id).prompt,
    });
    run.providerCallId = result.providerCallId;
    run.updatedAt = new Date().toISOString();
    publish();
  } catch (error) {
    await runStore.finish(run.id, {
      status: 'failed',
      summary: 'The call could not be started.',
      error: error.message,
    });
    publish();
  }
}
