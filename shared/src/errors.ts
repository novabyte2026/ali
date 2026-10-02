/**
 * Error taxonomy. Every failure that can reach a user is one of these codes,
 * each with a stable machine name, an HTTP status and a translation key.
 *
 * The API never returns a stack trace, a driver error, a provider payload or
 * the word "Internal Server Error" to a client. It returns a code, and the
 * frontend turns the code into human copy with a suggested next action.
 */

export const ERROR_CODES = [
  // --- Client input -------------------------------------------------------
  'ERROR_VALIDATION',
  'ERROR_QUERY_TOO_SHORT',
  'ERROR_UNSUPPORTED_COUNTRY',
  'ERROR_UNSUPPORTED_CURRENCY',
  'ERROR_INVALID_PRODUCT',
  'ERROR_INVALID_PRODUCT_URL',
  'ERROR_UNSUPPORTED_SOURCE',
  'ERROR_IMAGE_UNREADABLE',
  'ERROR_PAYLOAD_TOO_LARGE',

  // --- Authentication / authorization ------------------------------------
  'ERROR_AUTH_REQUIRED',
  'ERROR_AUTH_INVALID',
  'ERROR_AUTH_EXPIRED',
  'ERROR_FORBIDDEN',
  'ERROR_GUEST_FEATURE_REQUIRES_ACCOUNT',
  'ERROR_OAUTH_STATE_MISMATCH',
  'ERROR_OAUTH_PROVIDER_REFUSED',

  // --- Provider / source --------------------------------------------------
  'ERROR_SOURCE_TIMEOUT',
  'ERROR_SOURCE_UNAVAILABLE',
  'ERROR_SOURCE_DISABLED',
  'ERROR_SOURCE_NOT_CONFIGURED',
  'ERROR_RATE_LIMIT',
  'ERROR_PROVIDER_RATE_LIMIT',
  'ERROR_PROVIDER_AUTH_REJECTED',
  'ERROR_PROVIDER_RESPONSE_INVALID',
  'ERROR_DATA_UNAVAILABLE',

  // --- Compliance ---------------------------------------------------------
  'ERROR_POLICY_BLOCK',
  'ERROR_CAPABILITY_UNAVAILABLE',
  'ERROR_CAPABILITY_VERIFICATION_REQUIRED',
  'ERROR_DISCLOSURE_NOT_CONFIGURED',
  'ERROR_INVALID_AFFILIATE_LINK',
  'ERROR_CONTENT_USAGE_NOT_PERMITTED',
  'ERROR_DEMO_FIXTURES_IN_PRODUCTION',

  // --- Resources ----------------------------------------------------------
  'ERROR_NOT_FOUND',
  'ERROR_CONFLICT',
  'ERROR_LIMIT_REACHED',

  // --- Internal -----------------------------------------------------------
  'ERROR_INTERNAL',
  'ERROR_DEPENDENCY_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  ERROR_VALIDATION: 400,
  ERROR_QUERY_TOO_SHORT: 400,
  ERROR_UNSUPPORTED_COUNTRY: 400,
  ERROR_UNSUPPORTED_CURRENCY: 400,
  ERROR_INVALID_PRODUCT: 400,
  ERROR_INVALID_PRODUCT_URL: 400,
  ERROR_UNSUPPORTED_SOURCE: 400,
  ERROR_IMAGE_UNREADABLE: 400,
  ERROR_PAYLOAD_TOO_LARGE: 413,

  ERROR_AUTH_REQUIRED: 401,
  ERROR_AUTH_INVALID: 401,
  ERROR_AUTH_EXPIRED: 401,
  ERROR_FORBIDDEN: 403,
  ERROR_GUEST_FEATURE_REQUIRES_ACCOUNT: 401,
  ERROR_OAUTH_STATE_MISMATCH: 400,
  ERROR_OAUTH_PROVIDER_REFUSED: 502,

  ERROR_SOURCE_TIMEOUT: 504,
  ERROR_SOURCE_UNAVAILABLE: 503,
  ERROR_SOURCE_DISABLED: 503,
  ERROR_SOURCE_NOT_CONFIGURED: 503,
  ERROR_RATE_LIMIT: 429,
  ERROR_PROVIDER_RATE_LIMIT: 503,
  ERROR_PROVIDER_AUTH_REJECTED: 502,
  ERROR_PROVIDER_RESPONSE_INVALID: 502,
  ERROR_DATA_UNAVAILABLE: 200,

  ERROR_POLICY_BLOCK: 451,
  ERROR_CAPABILITY_UNAVAILABLE: 409,
  ERROR_CAPABILITY_VERIFICATION_REQUIRED: 409,
  ERROR_DISCLOSURE_NOT_CONFIGURED: 500,
  ERROR_INVALID_AFFILIATE_LINK: 502,
  ERROR_CONTENT_USAGE_NOT_PERMITTED: 451,
  ERROR_DEMO_FIXTURES_IN_PRODUCTION: 500,

  ERROR_NOT_FOUND: 404,
  ERROR_CONFLICT: 409,
  ERROR_LIMIT_REACHED: 429,

  ERROR_INTERNAL: 500,
  ERROR_DEPENDENCY_UNAVAILABLE: 503,
};

/** Codes whose details are safe to log at warn rather than error level. */
const EXPECTED_CODES = new Set<ErrorCode>([
  'ERROR_VALIDATION',
  'ERROR_QUERY_TOO_SHORT',
  'ERROR_NOT_FOUND',
  'ERROR_AUTH_REQUIRED',
  'ERROR_AUTH_EXPIRED',
  'ERROR_FORBIDDEN',
  'ERROR_GUEST_FEATURE_REQUIRES_ACCOUNT',
  'ERROR_RATE_LIMIT',
  'ERROR_CAPABILITY_UNAVAILABLE',
  'ERROR_CAPABILITY_VERIFICATION_REQUIRED',
  'ERROR_SOURCE_DISABLED',
  'ERROR_SOURCE_NOT_CONFIGURED',
  'ERROR_DATA_UNAVAILABLE',
]);

export function httpStatusForError(code: ErrorCode): number {
  return HTTP_STATUS[code] ?? 500;
}

export function isExpectedError(code: ErrorCode): boolean {
  return EXPECTED_CODES.has(code);
}

/** Translation key the frontend resolves for user-facing copy. */
export function messageKeyForError(code: ErrorCode): string {
  return `errors.${code}`;
}

export interface AppErrorDetails {
  /** Safe, non-sensitive context: field names, provider ids, limits. */
  readonly [key: string]: string | number | boolean | null | undefined | string[];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: AppErrorDetails | undefined;
  readonly retryable: boolean;
  /** Internal note for logs only. Never serialized to a client. */
  readonly internalNote: string | undefined;

  constructor(
    code: ErrorCode,
    options: {
      readonly message?: string;
      readonly details?: AppErrorDetails;
      readonly retryable?: boolean;
      readonly cause?: unknown;
      readonly internalNote?: string;
    } = {},
  ) {
    super(options.message ?? code, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = httpStatusForError(code);
    this.details = options.details;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.internalNote = options.internalNote;
  }

  /** The exact shape sent to clients. Nothing else leaves the process. */
  toPublicJSON(requestId: string): PublicErrorBody {
    return {
      error: {
        code: this.code,
        messageKey: messageKeyForError(this.code),
        details: this.details ?? null,
        retryable: this.retryable,
        requestId,
      },
    };
  }
}

export interface PublicErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly messageKey: string;
    readonly details: AppErrorDetails | null;
    readonly retryable: boolean;
    readonly requestId: string;
  };
}

function defaultRetryable(code: ErrorCode): boolean {
  switch (code) {
    case 'ERROR_SOURCE_TIMEOUT':
    case 'ERROR_SOURCE_UNAVAILABLE':
    case 'ERROR_RATE_LIMIT':
    case 'ERROR_PROVIDER_RATE_LIMIT':
    case 'ERROR_DEPENDENCY_UNAVAILABLE':
    case 'ERROR_INTERNAL':
      return true;
    default:
      return false;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Wraps an unknown throw into an AppError without leaking its message to the
 * client. The original message is preserved on `internalNote` for logs.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  const note = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return new AppError('ERROR_INTERNAL', { cause: value, internalNote: note });
}
