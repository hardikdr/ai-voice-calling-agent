import { EventEmitter } from 'node:events';

import { RunStore } from './run-store.js';
import { TunnelManager } from './tunnel.js';
import { TwilioTelephony } from './telephony.js';
import { buildMediaServer } from './media-server.js';
import { buildServer } from './server.js';

export async function buildRuntime({
  config,
  createTunnel = (options) => new TunnelManager(options),
  createTelephony = (options) => new TwilioTelephony(options),
  createMediaServer = buildMediaServer,
  createControlServer = buildServer,
}) {
  const runStore = new RunStore({ storagePath: config.storagePath });
  const runEvents = new EventEmitter();
  runEvents.setMaxListeners(100);
  const mediaSessions = new Map();
  const tunnel = createTunnel({
    mediaPort: config.mediaPort,
    publicMediaUrl: config.publicMediaUrl,
  });
  const publish = () => runEvents.emit('state', runStore.publicState());
  const telephony = createTelephony({
    accountSid: config.twilioAccountSid,
    authToken: config.twilioAuthToken,
    fromNumber: config.twilioFromNumber,
    tunnel,
    mediaSessions,
  });
  const mediaApp = await createMediaServer({
    config,
    runStore,
    mediaSessions,
    tunnel,
    publish,
  });
  const controlApp = await createControlServer({
    config,
    telephony,
    tunnel,
    runStore,
    runEvents,
  });

  let started = false;
  return {
    runStore,
    tunnel,
    async start() {
      if (started) throw new Error('Runtime is already started');
      started = true;
      try {
        await mediaApp.listen({ host: '0.0.0.0', port: config.mediaPort });
        await controlApp.listen({ host: '0.0.0.0', port: config.uiPort });
      } catch (error) {
        await closeQuietly(controlApp);
        await closeQuietly(mediaApp);
        started = false;
        throw error;
      }

      try {
        const publicUrl = await tunnel.start();
        return { tunnelReady: true, publicMediaUrl: publicUrl.href };
      } catch (tunnelError) {
        return { tunnelReady: false, tunnelError };
      }
    },
    async stop() {
      if (!started) return;
      started = false;
      await closeQuietly(controlApp);
      await closeQuietly(mediaApp);
      await tunnel.stop();
    },
  };
}

async function closeQuietly(app) {
  try {
    await app.close();
  } catch (error) {
    if (error?.code !== 'FST_ERR_REOPENED_CLOSE_SERVER') throw error;
  }
}
