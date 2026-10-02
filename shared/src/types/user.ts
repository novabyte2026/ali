import type { ProviderId } from './provider.js';
import type { SearchFilters, SortOption } from './search.js';

/**
 * Roles. Authorization is enforced in backend middleware against this role
 * plus explicit permission checks — never by hiding a button. A guest who
 * calls a user endpoint directly gets 401 from the server.
 */
export const ROLES = ['guest', 'user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'search:basic',
  'search:advanced_filters',
  'product:view',
  'comparison:basic',
  'comparison:cross_source',
  'coupon:view_public',
  'coupon:hunt_advanced',
  'deal:view_public',
  'deal:radar',
  'favorites:manage',
  'watchlist:manage',
  'saved_search:manage',
  'alert:manage',
  'cart:manage',
  'history:view',
  'upload:analyze_advanced',
  'preferences:manage',
  'account:delete',
  'admin:providers',
  'admin:compliance',
  'admin:analytics',
  'admin:users',
  'admin:debug_product',
  'admin:audit_log',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Guests get a genuinely useful product: search, results, product pages and
 * comparison. What they do not get is anything that requires us to keep state
 * about them — which is both the feature boundary and the privacy boundary.
 */
const GUEST_PERMISSIONS: ReadonlyArray<Permission> = [
  'search:basic',
  'product:view',
  'comparison:basic',
  'coupon:view_public',
  'deal:view_public',
];

const USER_PERMISSIONS: ReadonlyArray<Permission> = [
  ...GUEST_PERMISSIONS,
  'search:advanced_filters',
  'comparison:cross_source',
  'coupon:hunt_advanced',
  'deal:radar',
  'favorites:manage',
  'watchlist:manage',
  'saved_search:manage',
  'alert:manage',
  'cart:manage',
  'history:view',
  'upload:analyze_advanced',
  'preferences:manage',
  'account:delete',
];

const ADMIN_PERMISSIONS: ReadonlyArray<Permission> = [
  ...USER_PERMISSIONS,
  'admin:providers',
  'admin:compliance',
  'admin:analytics',
  'admin:users',
  'admin:debug_product',
  'admin:audit_log',
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlyArray<Permission>>> = {
  guest: GUEST_PERMISSIONS,
  user: USER_PERMISSIONS,
  admin: ADMIN_PERMISSIONS,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface UserPreferences {
  readonly locale: 'he' | 'en';
  readonly countryCode: string;
  readonly currency: string;
  readonly defaultSourceMode: 'all' | ProviderId;
  readonly defaultSort: SortOption;
  readonly reducedMotion: boolean;
}

/**
 * Consent is granular and defaults to off. Search history in particular is
 * off until the user turns it on — a comparison engine does not need to retain
 * what you looked for in order to work.
 */
export interface PrivacyPreferences {
  readonly storeSearchHistory: boolean;
  readonly personalizedRanking: boolean;
  readonly productAnalytics: boolean;
  readonly marketingEmails: boolean;
}

export interface NotificationPreferences {
  readonly emailAlerts: boolean;
  readonly inAppAlerts: boolean;
  readonly dealDigest: 'OFF' | 'DAILY' | 'WEEKLY';
}

export interface UserProfile {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly role: Role;
  readonly preferences: UserPreferences;
  readonly privacy: PrivacyPreferences;
  readonly notifications: NotificationPreferences;
  readonly createdAt: string;
}

/** Request-scoped identity. A guest is represented explicitly, never as null. */
export type Principal =
  | {
      readonly kind: 'guest';
      readonly sessionHash: string;
      readonly role: 'guest';
      readonly permissions: ReadonlyArray<Permission>;
    }
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly sessionId: string;
      readonly role: Role;
      readonly permissions: ReadonlyArray<Permission>;
      readonly email: string;
    };

export function principalHas(principal: Principal, permission: Permission): boolean {
  return principal.permissions.includes(permission);
}

export interface SavedSearch {
  readonly savedSearchId: string;
  readonly userId: string;
  readonly label: string;
  readonly query: string;
  readonly mode: 'all' | ProviderId;
  readonly filters: SearchFilters;
  readonly sort: SortOption;
  readonly notifyOnNewResults: boolean;
  readonly createdAt: string;
  readonly lastRunAt: string | null;
}

export interface FavoriteEntry {
  readonly favoriteId: string;
  readonly userId: string;
  readonly productGroupId: string;
  readonly providerId: ProviderId;
  readonly providerProductId: string;
  readonly note: string | null;
  readonly createdAt: string;
}
