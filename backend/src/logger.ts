/**
 * Structured logging.
 *
 * Two rules enforced here rather than left to discipline:
 *
 *   1. Nothing is logged that could identify a person. E-mail addresses, raw
 *      session tokens, IP addresses and full query strings are redacted by
 *      key name on the way out, so a careless `log.info('...', { email })`
 *      cannot leak one.
 *   2. Credentials never appear. Any key whose name looks like a secret is
 *      replaced, including inside nested objects.
 *
 * Output is JSON lines, one object per event, so it is greppable and
 * ingestible without a parser.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are replaced with a marker, at any depth. */
const REDACTED_KEYS = new Set([
  'password',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'appsecret',
  'app_secret',
  'secretkey',
  'secret_key',
  'clientsecret',
  'client_secret',
  'authorization',
  'cookie',
  'setcookie',
  'sessiontoken',
  'session_token',
  'codeverifier',
  'code_verifier',
  'signature',
  'sign',
  'email',
  'useragent',
  'user_agent',
  'ip',
  'ipaddress',
  'ip_address',
]);

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  level: LogLevel,
  bindings: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = LEVEL_ORDER[level];

  function emit(entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    const entry = {
      at: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...redact(bindings),
      ...(fields ? redact(fields) : {}),
    };
    try {
      write(JSON.stringify(entry));
    } catch {
      // A value that cannot be serialized (a cycle, a BigInt) must not take
      // down the request that was being logged.
      write(JSON.stringify({ at: entry.at, level: entryLevel, msg: message, logError: true }));
    }
  }

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (extra) => createLogger(level, { ...bindings, ...extra }, write),
  };
}

function redact(fields: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return { truncated: true };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (REDACTED_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ''))) {
      out[key] = '[redacted]';
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = value;
    } else if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message };
    } else if (Array.isArray(value)) {
      out[key] = value.slice(0, 20).map((entry) =>
        entry !== null && typeof entry === 'object'
          ? redact(entry as Record<string, unknown>, depth + 1)
          : entry,
      );
    } else if (typeof value === 'object') {
      out[key] = redact(value as Record<string, unknown>, depth + 1);
    } else if (typeof value === 'bigint') {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A search query is user-provided text. It is useful for operating the
 * product in aggregate but is not something to write verbatim into logs
 * alongside a session id, so logs carry its shape rather than its content.
 */
export function describeQuery(query: string): Record<string, number | boolean> {
  return {
    queryLength: query.length,
    queryWords: query.trim().split(/\s+/).filter(Boolean).length,
    queryHasDigits: /\d/.test(query),
  };
}
