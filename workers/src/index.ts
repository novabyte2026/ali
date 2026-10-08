import { createDatabase, createLogger, loadConfig } from '@shelf/backend';
import { JobRunner } from './runner.js';
import { retentionSweepJob } from './jobs/retention-sweep.js';
import { couponCheckerJob } from './jobs/coupon-checker.js';
import { complianceMonitorJob } from './jobs/compliance-monitor.js';
import { affiliateLinkMonitorJob } from './jobs/affiliate-link-monitor.js';
import { notificationDispatcherJob } from './jobs/notification-dispatcher.js';

/**
 * Worker process.
 *
 * Runs the periodic jobs that keep the system honest and tidy over time:
 * retention sweeps, coupon status decay, compliance monitoring, affiliate link
 * health, and notification delivery.
 *
 * It shares the backend's config and database so there is one definition of
 * each, and it binds no port — a worker that accidentally served HTTP would be
 * a surprising attack surface.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel, { service: 'shelf-workers' });
  const db = createDatabase(config, log);

  log.info('Starting Shelf workers', { nodeEnv: config.nodeEnv });

  if (!(await db.healthy())) {
    log.error('Database is not reachable; refusing to start workers');
    await db.close();
    process.exit(1);
  }

  const runner = new JobRunner(db, log);

  runner.start([
    retentionSweepJob,
    couponCheckerJob,
    complianceMonitorJob,
    affiliateLinkMonitorJob,
    notificationDispatcherJob,
  ]);

  const shutdown = async (signal: string): Promise<void> => {
    log.info('Shutting down workers', { signal });
    await runner.stop();
    await db.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection in worker', {
      error: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });

  log.info('Workers running');
}

await main();
