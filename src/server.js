import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { ActiveCallError, RunStore } from './run-store.js';
import { ValidationError, validateCallInstruction } from './call-instruction.js';
import { buildAgentPrompt } from './prompt.js';
import { runDryCall } from './dry-run.js';

export async function buildServer({
  config,
  telephony,
  tunnel,
  runStore = new RunStore({ storagePath: config.storagePath }),
  runEvents = new EventEmitter(),
  dryRunDelayMs = 150,
}) {
  const app = Fastify({ logger: false });
  runEvents.setMaxListeners(100);
  const controllers = new Map();

  app.runStore = runStore;
  app.runEvents = runEvents;

  const publicRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, {
    root: publicRoot,
    wildcard: false,
    list: false,
  });

  const publish = () => runEvents.emit('state', runStore.publicState());
  const hasCredentials = () => {
    if (!config.openaiApiKey) return false;
    if (config.telephonyProvider === 'telnyx') {
      return Boolean(
        config.telnyxApiKey
          && config.telnyxConnectionId
          && config.telnyxFromNumber
          && config.telnyxPublicKey,
      );
    }
    return Boolean(config.twilioAccountSid && config.twilioAuthToken && config.twilioFromNumber);
  };

  app.get('/healthz', async () => ({
    ok: true,
    dryRunReady: true,
    mediaTunnelReady: Boolean(tunnel?.ready),
    realCallReady: hasCredentials() && Boolean(telephony) && Boolean(tunnel?.ready),
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

    if (!instruction.dry_run && (!hasCredentials() || !telephony || !tunnel?.ready)) {
      return reply.code(503).send({
        error: `Real calls require configured OpenAI and ${config.telephonyProvider ?? 'twilio'} credentials plus a ready media tunnel`,
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
    const resource = { controller, timer: null };
    controllers.set(run.id, resource);
    const operation = instruction.dry_run
      ? runDryCall({
        runStore,
        runId: run.id,
        signal: controller.signal,
        delayMs: dryRunDelayMs,
        onChange: publish,
      })
      : startRealCall({ telephony, runStore, run, publish });

    if (instruction.dry_run) {
      operation.finally(() => clearResource(run.id));
    } else {
      operation.then((started) => {
        if (!started) return clearResource(run.id);
        resource.timer = setTimeout(() => {
          void stopRealCall(run.id, 'Maximum call duration reached');
        }, config.maxCallSeconds * 1_000);
        resource.timer.unref?.();
      });
    }
    return reply.code(202).send({ runId: run.id });
  });

  app.post('/api/calls/:runId/hangup', async (request, reply) => {
    const run = runStore.getRun(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      return reply.code(409).send({ error: 'Run is already finished' });
    }

    controllers.get(run.id)?.controller.abort();
    if (run.instruction.dry_run) {
      await runStore.cancel(run.id, 'Cancelled by user');
      publish();
    } else {
      await stopRealCall(run.id, 'Cancelled by user');
    }
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

  const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
  const clearResource = (runId) => {
    const resource = controllers.get(runId);
    if (resource?.timer) clearTimeout(resource.timer);
    controllers.delete(runId);
  };
  const clearFinishedResources = () => {
    for (const runId of controllers.keys()) {
      if (terminalStatuses.has(runStore.getRun(runId)?.status)) clearResource(runId);
    }
  };
  runEvents.on('state', clearFinishedResources);

  async function stopRealCall(runId, reason) {
    const run = runStore.getRun(runId);
    if (!run || terminalStatuses.has(run.status)) return clearResource(runId);
    await runStore.cancel(runId, reason);
    publish();
    try {
      await telephony?.hangup(run);
    } finally {
      clearResource(runId);
    }
  }

  app.addHook('onClose', async () => {
    runEvents.off('state', clearFinishedResources);
    for (const { controller, timer } of controllers.values()) {
      controller.abort();
      if (timer) clearTimeout(timer);
    }
    const active = runStore.publicState().activeRun;
    if (active && !active.instruction.dry_run) await stopRealCall(active.id, 'Service shutting down');
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
    return true;
  } catch (error) {
    await runStore.finish(run.id, {
      status: 'failed',
      summary: 'The call could not be started.',
      error: error.message,
    });
    publish();
    return false;
  }
}
