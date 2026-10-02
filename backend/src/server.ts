import { migrateUp, migrationStatus } from '@shelf/database/runner';
import { buildApp } from './app.js';
import { createContext } from './context.js';
import { describeConfig, loadConfig } from './config/index.js';

/**
 * Entry point.
 *
 * Boot order matters:
 *   1. Load and validate configuration. An invalid configuration is a refusal
 *      to start, not a warning — see config/index.ts for the list.
 *   2. Verify the schema is current. Serving against a stale schema produces
 *      errors that look like application bugs.
 *   3. Seed exchange rates if the table is empty, so a first boot can convert.
 *   4. Listen, then log a boot summary naming what is configured and what is
 *      degraded, with no credential values.
 */

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);

  ctx.log.info('Starting Shelf backend', describeConfig(config));

  if (config.integrations.allowDemoFixtures) {
    const demoProviders = ctx.registry
      .filter((entry) => entry.servingDemoFixtures)
      .map((entry) => entry.providerId);
    if (demoProviders.length > 0) {
      // Loud on purpose. Every response from these providers is labelled, and
      // this line is how an operator notices before a user does.
      ctx.log.warn(
        'DEMO FIXTURES ACTIVE — these providers serve clearly-labelled sample data, not real offers',
        { providers: demoProviders },
      );
    }
  }

  // --- Schema -------------------------------------------------------------
  try {
    if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
      const result = await migrateUp(ctx.db.pool);
      if (!result.alreadyUpToDate) {
        ctx.log.info('Applied migrations on boot', { count: result.applied.length });
      }
    }

    const statuses = await migrationStatus(ctx.db.pool);
    const pending = statuses.filter((status) => status.state !== 'APPLIED');
    if (pending.length > 0) {
      ctx.log.error('Database schema is not current; refusing to start', {
        pending: pending.map((status) => `${status.filename}:${status.state}`),
      });
      await ctx.shutdown();
      process.exit(1);
    }
  } catch (error) {
    ctx.log.error('Could not verify database schema', { error });
    await ctx.shutdown();
    process.exit(1);
  }

  // --- Exchange rates -----------------------------------------------------
  try {
    const existing = await ctx.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM exchange_rates',
    );
    if (Number.parseInt(existing.rows[0]?.count ?? '0', 10) === 0) {
      const loaded = await ctx.converter.refresh();
      ctx.log.info('Seeded exchange rates', { count: loaded, driver: config.fx.driver });
    }
  } catch (error) {
    // Without rates, converted prices come back UNKNOWN rather than wrong, so
    // this degrades rather than blocks.
    ctx.log.warn('Could not seed exchange rates; conversions will report as unavailable', {
      error,
    });
  }

  const app = await buildApp(ctx);

  // --- Shutdown -----------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info('Shutting down', { signal });

    // Stop accepting connections, let in-flight requests finish, then release
    // the pool. A hard exit here would drop a user's search mid-stream.
    const timer = setTimeout(() => {
      ctx.log.error('Shutdown timed out, exiting');
      process.exit(1);
    }, 10_000);
    timer.unref();

    try {
      await app.close();
      await ctx.shutdown();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      ctx.log.error('Shutdown failed', { error });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    ctx.log.error('Unhandled rejection', {
      error: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
  process.on('uncaughtException', (error) => {
    ctx.log.error('Uncaught exception, exiting', { error });
    void shutdown('uncaughtException');
  });

  try {
    await app.listen({ host: config.http.host, port: config.http.port });

    const providers = await ctx.policies.all();
    ctx.log.info('Listening', {
      port: config.http.port,
      providers: providers.map((entry) => ({
        id: entry.providerId,
        enabled: entry.providerEnabled,
        search: entry.effective.search,
        policyVersion: entry.policy.policyVersion,
        policyStale: entry.policyStale,
      })),
      searchableProviders: (await ctx.policies.searchableProviderIds()).length,
    });
  } catch (error) {
    ctx.log.error('Failed to listen', { error });
    await ctx.shutdown();
    process.exit(1);
  }
}

await main();
