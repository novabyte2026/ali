import pg from 'pg';
import { AppError } from '@shelf/shared';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

/**
 * Postgres access.
 *
 * Every query in this codebase goes through `query` or `tx` below and uses
 * parameter placeholders. There is no string-concatenated SQL anywhere, and no
 * helper that takes a raw fragment from a caller — which is what makes SQL
 * injection a non-issue rather than a review item.
 *
 * Driver errors are translated at this boundary so that nothing above it ever
 * sees a Postgres error code, and nothing a client receives mentions a table
 * or a constraint name.
 */

export type Db = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<pg.QueryResult<T>>;
};

export interface Database extends Db {
  /** Runs `fn` inside a transaction, rolling back on any throw. */
  tx<T>(fn: (client: Db) => Promise<T>): Promise<T>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
  readonly pool: pg.Pool;
}

// Postgres returns BIGINT as a string to avoid precision loss. Money is held
// in minor units well inside the safe-integer range, so parsing to a number
// here is safe and saves every call site a conversion.
pg.types.setTypeParser(20, (value: string) => Number.parseInt(value, 10));
// NUMERIC stays a string: it is used for rates and scores where silent
// float conversion would be a precision bug.

export function createDatabase(config: AppConfig, log: Logger): Database {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A query that has run for 15 seconds is not going to help the request
    // that started it; letting it continue holds a connection hostage.
    statement_timeout: 15_000,
    query_timeout: 15_000,
    ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: 'shelf-backend',
  });

  pool.on('error', (error) => {
    // An idle client erroring is normal during a failover; it must not crash
    // the process.
    log.warn('Idle database client error', { error });
  });

  async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<pg.QueryResult<T>> {
    try {
      return await pool.query<T>(sql, params as unknown[]);
    } catch (error) {
      throw translate(error, log);
    }
  }

  return {
    query,
    pool,

    async tx<T>(fn: (client: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const wrapped: Db = {
          query: async (sql, params = []) => {
            try {
              return await client.query(sql, params as unknown[]);
            } catch (error) {
              throw translate(error, log);
            }
          },
        };
        const result = await fn(wrapped);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          log.error('Rollback failed', { error: rollbackError });
        }
        throw error instanceof AppError ? error : translate(error, log);
      } finally {
        client.release();
      }
    },

    async healthy(): Promise<boolean> {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Maps driver errors to our taxonomy. The original message is kept on
 * `internalNote` for logs; the client only ever sees the code.
 */
function translate(error: unknown, log: Logger): AppError {
  const code = (error as { code?: string } | null)?.code;
  const note = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  switch (code) {
    // unique_violation
    case '23505':
      return new AppError('ERROR_CONFLICT', { internalNote: note, cause: error });
    // foreign_key_violation
    case '23503':
      return new AppError('ERROR_NOT_FOUND', { internalNote: note, cause: error });
    // check_violation / not_null_violation
    case '23514':
    case '23502':
      return new AppError('ERROR_VALIDATION', { internalNote: note, cause: error });
    // query_canceled (statement timeout)
    case '57014':
      return new AppError('ERROR_DEPENDENCY_UNAVAILABLE', {
        internalNote: `Statement timeout. ${note}`,
        cause: error,
      });
    // connection failures
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case '08006':
    case '08003':
      log.error('Database unavailable', { code });
      return new AppError('ERROR_DEPENDENCY_UNAVAILABLE', { internalNote: note, cause: error });
    default:
      log.error('Unexpected database error', { code, error });
      return new AppError('ERROR_INTERNAL', { internalNote: note, cause: error });
  }
}

/** Single row or undefined, for the common lookup case. */
export function firstRow<T extends pg.QueryResultRow>(result: pg.QueryResult<T>): T | undefined {
  return result.rows[0];
}

/** Single row, or a 404. Saves repeating the same three lines everywhere. */
export function requireRow<T extends pg.QueryResultRow>(
  result: pg.QueryResult<T>,
  subject: string,
): T {
  const row = result.rows[0];
  if (!row) {
    throw new AppError('ERROR_NOT_FOUND', { details: { subject } });
  }
  return row;
}
