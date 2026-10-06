import mongoose from 'mongoose';
import { getEnv, missingProductionConfig } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { startJobs } from './jobs/index.js';
import { seedServices } from './services/catalog/catalog.service.js';
import './models/index.js';

async function main() {
  const env = getEnv();
  if (env.isProd) {
    const missing = missingProductionConfig(env);
    if (missing.length) {
      logger.fatal({ missing }, 'missing required production configuration');
      process.exit(1);
    }
  }

  mongoose.set('strictQuery', true);
  mongoose.connection.on('disconnected', () => logger.error({ action: 'mongo' }, 'MongoDB disconnected'));
  mongoose.connection.on('reconnected', () => logger.info({ action: 'mongo' }, 'MongoDB reconnected'));
  await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10000 });
  // Additive only (never drops indexes). Unique indexes are what make idempotency and de-duplication safe.
  await Promise.all(Object.values(mongoose.models).map((m) => m.createIndexes()));
  await seedServices();                   // inserts missing defaults only; never overwrites DutyLaunch's edits
  logger.info({ action: 'mongo' }, 'MongoDB connected, indexes ensured');

  const { app, container, webhook } = createApp({});
  const jobs = startJobs({ engine: container.engine, webhook, messenger: container.messenger, analytics: container.analytics, logger });
  const server = app.listen(env.port, () => logger.info({ action: 'listen', port: env.port, multiselectMode: env.multiselectMode }, 'DutyLaunch bot listening'));

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info({ action: 'shutdown', signal }, 'shutting down');
    jobs.stop();
    server.close();
    await webhook.drain().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ action: 'unhandled_rejection', errorCategory: err?.name }, 'unhandled rejection'));
}

main().catch((err) => { logger.fatal({ errorCategory: err?.name, msg: err?.message }, 'startup failed'); process.exit(1); });
