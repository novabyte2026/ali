import { createPool, migrateUp, migrationStatus } from './runner.js';

/**
 * Migration CLI. Reads DATABASE_URL from the environment; it never accepts a
 * connection string as an argument, so a URL with a password cannot end up in
 * shell history or a process listing.
 */

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exit(2);
  }
  return url;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const pool = createPool(requireDatabaseUrl(), process.env.DATABASE_SSL === 'true');

  try {
    switch (command) {
      case 'up': {
        const result = await migrateUp(pool);
        if (result.alreadyUpToDate) {
          console.log('Schema is up to date.');
        } else {
          for (const entry of result.applied) {
            console.log(`Applied ${entry.id} in ${entry.durationMs}ms`);
          }
          console.log(`${result.applied.length} migration(s) applied.`);
        }
        break;
      }

      case 'status': {
        const statuses = await migrationStatus(pool);
        const width = Math.max(...statuses.map((s) => s.filename.length), 10);
        for (const status of statuses) {
          const when = status.appliedAt ? status.appliedAt.slice(0, 19).replace('T', ' ') : '-';
          console.log(`${status.filename.padEnd(width)}  ${status.state.padEnd(18)}  ${when}`);
        }
        const problems = statuses.filter(
          (s) => s.state === 'CHECKSUM_MISMATCH' || s.state === 'MISSING_FILE',
        );
        if (problems.length > 0) process.exitCode = 1;
        break;
      }

      /** Fails if anything is pending. Used as a deployment gate. */
      case 'verify': {
        const statuses = await migrationStatus(pool);
        const pending = statuses.filter((s) => s.state !== 'APPLIED');
        if (pending.length === 0) {
          console.log(`Schema verified: ${statuses.length} migration(s) applied.`);
        } else {
          for (const status of pending) {
            console.error(`${status.state}: ${status.filename}`);
          }
          process.exitCode = 1;
        }
        break;
      }

      default:
        console.error(`Unknown command "${command}". Use: up | status | verify`);
        process.exitCode = 2;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

await main();
