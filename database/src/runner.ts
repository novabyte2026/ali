import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Forward-only migration runner.
 *
 * Deliberately has no `down`. A rollback script that has never been run is a
 * false sense of safety; recovering a bad migration in production means
 * restoring from backup or writing a new forward migration, and pretending
 * otherwise encourages risky changes.
 *
 * Each file's checksum is recorded. Editing an applied migration is an error
 * rather than a silent divergence between environments.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  readonly id: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly id: string;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly durationMs: number;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const filename of files) {
    const id = filename.split('_')[0];
    if (!id || !/^\d{4}$/.test(id)) {
      throw new Error(
        `Migration "${filename}" must start with a four-digit sequence, e.g. 0008_add_thing.sql`,
      );
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    migrations.push({
      id,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex').slice(0, 32),
    });
  }

  const seen = new Set<string>();
  for (const migration of migrations) {
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate migration sequence ${migration.id}`);
    }
    seen.add(migration.id);
  }

  return migrations;
}

async function ensureLedger(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export async function listApplied(client: pg.PoolClient): Promise<AppliedMigration[]> {
  await ensureLedger(client);
  const result = await client.query<{
    id: string;
    filename: string;
    checksum: string;
    applied_at: Date;
    duration_ms: number;
  }>('SELECT id, filename, checksum, applied_at, duration_ms FROM schema_migrations ORDER BY id');
  return result.rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
  }));
}

export interface MigrateResult {
  readonly applied: ReadonlyArray<{ readonly id: string; readonly durationMs: number }>;
  readonly alreadyUpToDate: boolean;
}

/**
 * Applies pending migrations. Each file runs inside its own transaction, so a
 * failure leaves the database at the last good migration rather than
 * half-applied.
 *
 * A session-level advisory lock serializes concurrent deploys: two instances
 * booting at once will not both try to create the same table.
 */
export async function migrateUp(pool: pg.Pool, dir?: string): Promise<MigrateResult> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  const applied: Array<{ id: string; durationMs: number }> = [];

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['shelf_migrations']);
    await ensureLedger(client);

    const alreadyApplied = new Map(
      (await listApplied(client)).map((row) => [row.id, row] as const),
    );

    for (const migration of migrations) {
      const existing = alreadyApplied.get(migration.id);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} was changed after it was applied ` +
              `(recorded ${existing.checksum}, file ${migration.checksum}). ` +
              'Applied migrations are immutable — add a new forward migration instead.',
          );
        }
        continue;
      }

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        const durationMs = Date.now() - startedAt;
        await client.query(
          'INSERT INTO schema_migrations (id, filename, checksum, duration_ms) VALUES ($1, $2, $3, $4)',
          [migration.id, migration.filename, migration.checksum, durationMs],
        );
        await client.query('COMMIT');
        applied.push({ id: migration.id, durationMs });
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }

    return { applied, alreadyUpToDate: applied.length === 0 };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['shelf_migrations']);
    client.release();
  }
}

export interface MigrationStatus {
  readonly id: string;
  readonly filename: string;
  readonly state: 'APPLIED' | 'PENDING' | 'CHECKSUM_MISMATCH' | 'MISSING_FILE';
  readonly appliedAt: string | null;
}

export async function migrationStatus(pool: pg.Pool, dir?: string): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);
  const client = await pool.connect();
  try {
    const appliedRows = await listApplied(client);
    const appliedById = new Map(appliedRows.map((row) => [row.id, row] as const));
    const fileById = new Map(migrations.map((m) => [m.id, m] as const));

    const statuses: MigrationStatus[] = migrations.map((migration) => {
      const record = appliedById.get(migration.id);
      if (!record) {
        return { id: migration.id, filename: migration.filename, state: 'PENDING', appliedAt: null };
      }
      return {
        id: migration.id,
        filename: migration.filename,
        state: record.checksum === migration.checksum ? 'APPLIED' : 'CHECKSUM_MISMATCH',
        appliedAt: record.appliedAt.toISOString(),
      };
    });

    // A migration recorded in the database with no file on disk means the
    // deployment is older than the database — worth failing loudly over.
    for (const record of appliedRows) {
      if (!fileById.has(record.id)) {
        statuses.push({
          id: record.id,
          filename: record.filename,
          state: 'MISSING_FILE',
          appliedAt: record.appliedAt.toISOString(),
        });
      }
    }

    return statuses.sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    client.release();
  }
}

export function createPool(connectionString: string, useSsl: boolean): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 4,
    ssl: useSsl ? { rejectUnauthorized: true } : undefined,
  });
}
