import 'dotenv/config';

import { loadConfig } from './config.js';
import { buildRuntime } from './runtime.js';

const config = loadConfig();
const runtime = await buildRuntime({ config });

const shutdown = async (signal) => {
  console.log(`Shutting down after ${signal}`);
  await runtime.stop();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const result = await runtime.start();
console.log(`Control panel ready at http://0.0.0.0:${config.uiPort}`);
if (result.tunnelReady) {
  console.log(`Public media tunnel ready at ${result.publicMediaUrl}`);
} else {
  console.error(`Public media tunnel unavailable; dry-run remains ready: ${result.tunnelError.message}`);
}
