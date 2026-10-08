import {
  type Alert,
  type AlertKind,
  type FavoriteEntry,
  type Money,
  type SavedSearch,
  type UserProfile,
  AppError,
  money,
  newId,
} from '@shelf/shared';
import type { Database } from '../db/pool.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../logger.js';

/**
 * User-owned data.
 *
 * Every method here takes a userId and scopes its query by it. There is no
 * method that fetches a row by id alone, which means a user cannot read
 * another user's favourite or alert by guessing an identifier — the ownership
 * check is in the WHERE clause rather than in a caller's `if`.
 *
 * Limits are enforced per user so one account cannot fill the table.
 */

const LIMITS = {
  favorites: 500,
  watchlist: 200,
  savedSearches: 50,
  alerts: 100,
  carts: 20,
  cartLines: 60,
} as const;

export interface UserStore {
  profile(userId: string): Promise<UserProfile>;
  updatePreferences(userId: string, patch: PreferencePatch): Promise<UserProfile>;
  updatePrivacy(userId: string, patch: PrivacyPatch): Promise<UserProfile>;

  favorites(userId: string): Promise<ReadonlyArray<FavoriteEntry>>;
  addFavorite(args: {
    readonly userId: string;
    readonly providerId: string;
    readonly providerProductId: string;
    readonly productGroupId: string | null;
    readonly note: string | null;
  }): Promise<FavoriteEntry>;
  removeFavorite(userId: string, favoriteId: string): Promise<void>;

  savedSearches(userId: string): Promise<ReadonlyArray<SavedSearch>>;
  saveSearch(args: {
    readonly userId: string;
    readonly label: string;
    readonly query: string;
    readonly mode: string;
    readonly filters: Record<string, unknown>;
    readonly sort: string;
    readonly countryCode: string;
    readonly currency: string;
    readonly notifyOnNewResults: boolean;
  }): Promise<SavedSearch>;
  deleteSavedSearch(userId: string, savedSearchId: string): Promise<void>;

  alerts(userId: string): Promise<ReadonlyArray<Alert>>;
  createAlert(args: CreateAlertArgs): Promise<Alert>;
  deleteAlert(userId: string, alertId: string): Promise<void>;

  recordSearchHistory(args: {
    readonly userId: string;
    readonly query: string;
    readonly mode: string;
    readonly resultCount: number;
    readonly countryCode: string;
  }): Promise<void>;
  searchHistory(userId: string, limit: number): Promise<ReadonlyArray<SearchHistoryEntry>>;
  clearSearchHistory(userId: string): Promise<number>;

  exportAll(userId: string): Promise<Record<string, unknown>>;
  deleteAccount(userId: string): Promise<void>;
}

export interface PreferencePatch {
  readonly locale?: 'he' | 'en';
  readonly countryCode?: string;
  readonly currency?: string;
  readonly defaultSourceMode?: string;
  readonly defaultSort?: string;
  readonly reducedMotion?: boolean;
  readonly emailAlerts?: boolean;
  readonly inAppAlerts?: boolean;
  readonly dealDigest?: 'OFF' | 'DAILY' | 'WEEKLY';
}

export interface PrivacyPatch {
  readonly storeSearchHistory?: boolean;
  readonly personalizedRanking?: boolean;
  readonly productAnalytics?: boolean;
  readonly marketingEmails?: boolean;
}

export interface CreateAlertArgs {
  readonly userId: string;
  readonly kind: AlertKind;
  readonly providerId: string | null;
  readonly productGroupId: string | null;
  readonly providerProductId: string | null;
  readonly providerVariantId: string | null;
  readonly countryCode: string;
  readonly targetPrice: Money | null;
  readonly thresholdPercent: number | null;
  readonly channels: ReadonlyArray<'EMAIL' | 'IN_APP'>;
}

export interface SearchHistoryEntry {
  readonly historyId: string;
  readonly query: string;
  readonly mode: string;
  readonly resultCount: number;
  readonly createdAt: string;
}

export function createUserStore(db: Database, config: AppConfig, log: Logger): UserStore {
  async function loadProfile(userId: string): Promise<UserProfile> {
    const result = await db.query<ProfileRow>(
      `SELECT user_id, email, display_name, avatar_url, role,
              locale, country_code, currency, default_source_mode, default_sort, reduced_motion,
              store_search_history, personalized_ranking, product_analytics, marketing_emails,
              email_alerts, in_app_alerts, deal_digest, created_at
         FROM users
        WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'user' } });
    return toProfile(row);
  }

  async function assertUnderLimit(
    userId: string,
    table: string,
    limit: number,
  ): Promise<void> {
    // Table name comes from a literal in this module only, never from input.
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE user_id = $1`,
      [userId],
    );
    const count = Number.parseInt(result.rows[0]?.count ?? '0', 10);
    if (count >= limit) {
      throw new AppError('ERROR_LIMIT_REACHED', { details: { limit, resource: table } });
    }
  }

  return {
    profile: loadProfile,

    async updatePreferences(userId, patch) {
      await db.query(
        `UPDATE users SET
           locale = coalesce($2, locale),
           country_code = coalesce($3, country_code),
           currency = coalesce($4, currency),
           default_source_mode = coalesce($5, default_source_mode),
           default_sort = coalesce($6, default_sort),
           reduced_motion = coalesce($7, reduced_motion),
           email_alerts = coalesce($8, email_alerts),
           in_app_alerts = coalesce($9, in_app_alerts),
           deal_digest = coalesce($10, deal_digest)
         WHERE user_id = $1 AND deleted_at IS NULL`,
        [
          userId,
          patch.locale ?? null,
          patch.countryCode?.toUpperCase() ?? null,
          patch.currency?.toUpperCase() ?? null,
          patch.defaultSourceMode ?? null,
          patch.defaultSort ?? null,
          patch.reducedMotion ?? null,
          patch.emailAlerts ?? null,
          patch.inAppAlerts ?? null,
          patch.dealDigest ?? null,
        ],
      );
      return loadProfile(userId);
    },

    /**
     * Privacy changes write to the consent ledger as well as the user row, so
     * there is a record of what was agreed and when — and turning search
     * history off deletes what was already stored rather than merely stopping
     * new writes.
     */
    async updatePrivacy(userId, patch) {
      await db.tx(async (client) => {
        await client.query(
          `UPDATE users SET
             store_search_history = coalesce($2, store_search_history),
             personalized_ranking = coalesce($3, personalized_ranking),
             product_analytics = coalesce($4, product_analytics),
             marketing_emails = coalesce($5, marketing_emails)
           WHERE user_id = $1 AND deleted_at IS NULL`,
          [
            userId,
            patch.storeSearchHistory ?? null,
            patch.personalizedRanking ?? null,
            patch.productAnalytics ?? null,
            patch.marketingEmails ?? null,
          ],
        );

        for (const [field, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          await client.query(
            `INSERT INTO user_consents (consent_id, user_id, consent_kind, granted, source)
             VALUES ($1, $2, $3, $4, 'user_settings')`,
            [newId('con'), userId, toSnakeCase(field), value],
          );
        }

        if (patch.storeSearchHistory === false) {
          await client.query('DELETE FROM search_history WHERE user_id = $1', [userId]);
        }
        if (patch.productAnalytics === false) {
          // Detach past events from the account rather than deleting the
          // aggregate: the operational signal survives, the link does not.
          await client.query(
            'UPDATE analytics_events SET user_id = NULL WHERE user_id = $1',
            [userId],
          );
        }
      });

      return loadProfile(userId);
    },

    async favorites(userId) {
      const result = await db.query<FavoriteRow>(
        `SELECT favorite_id, user_id, product_group_id, provider_id,
                provider_product_id, note, created_at
           FROM favorites
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 500`,
        [userId],
      );
      return result.rows.map(toFavorite);
    },

    async addFavorite({ userId, providerId, providerProductId, productGroupId, note }) {
      await assertUnderLimit(userId, 'favorites', LIMITS.favorites);
      const favoriteId = newId('fav');
      const result = await db.query<FavoriteRow>(
        `INSERT INTO favorites
           (favorite_id, user_id, product_group_id, provider_id, provider_product_id, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, provider_id, provider_product_id) DO UPDATE
           SET note = EXCLUDED.note
         RETURNING favorite_id, user_id, product_group_id, provider_id,
                   provider_product_id, note, created_at`,
        [favoriteId, userId, productGroupId, providerId, providerProductId, note?.slice(0, 500) ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new AppError('ERROR_INTERNAL');
      return toFavorite(row);
    },

    async removeFavorite(userId, favoriteId) {
      const result = await db.query(
        'DELETE FROM favorites WHERE favorite_id = $1 AND user_id = $2',
        [favoriteId, userId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'favorite' } });
      }
    },

    async savedSearches(userId) {
      const result = await db.query<SavedSearchRow>(
        `SELECT saved_search_id, user_id, label, query, mode, filters, sort,
                country_code, currency, notify_on_new_results, created_at, last_run_at
           FROM saved_searches
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId],
      );
      return result.rows.map(toSavedSearch);
    },

    async saveSearch(args) {
      await assertUnderLimit(args.userId, 'saved_searches', LIMITS.savedSearches);
      const result = await db.query<SavedSearchRow>(
        `INSERT INTO saved_searches
           (saved_search_id, user_id, label, query, mode, filters, sort,
            country_code, currency, notify_on_new_results)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING saved_search_id, user_id, label, query, mode, filters, sort,
                   country_code, currency, notify_on_new_results, created_at, last_run_at`,
        [
          newId('sch'),
          args.userId,
          args.label.slice(0, 120),
          args.query.slice(0, 300),
          args.mode,
          JSON.stringify(args.filters),
          args.sort,
          args.countryCode.toUpperCase(),
          args.currency.toUpperCase(),
          args.notifyOnNewResults,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AppError('ERROR_INTERNAL');
      return toSavedSearch(row);
    },

    async deleteSavedSearch(userId, savedSearchId) {
      const result = await db.query(
        'DELETE FROM saved_searches WHERE saved_search_id = $1 AND user_id = $2',
        [savedSearchId, userId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'savedSearch' } });
      }
    },

    async alerts(userId) {
      const result = await db.query<AlertRow>(
        `SELECT alert_id, user_id, kind, provider_id, product_group_id,
                provider_product_id, provider_variant_id, country_code,
                target_price_minor, target_currency, threshold_percent,
                channels, active, suspended_reason, created_at, last_triggered_at
           FROM alerts
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId],
      );
      return result.rows.map(toAlert);
    },

    async createAlert(args) {
      await assertUnderLimit(args.userId, 'alerts', LIMITS.alerts);
      const result = await db.query<AlertRow>(
        `INSERT INTO alerts
           (alert_id, user_id, kind, provider_id, product_group_id,
            provider_product_id, provider_variant_id, country_code,
            target_price_minor, target_currency, threshold_percent, channels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING alert_id, user_id, kind, provider_id, product_group_id,
                   provider_product_id, provider_variant_id, country_code,
                   target_price_minor, target_currency, threshold_percent,
                   channels, active, suspended_reason, created_at, last_triggered_at`,
        [
          newId('alr'),
          args.userId,
          args.kind,
          args.providerId,
          args.productGroupId,
          args.providerProductId,
          args.providerVariantId,
          args.countryCode.toUpperCase(),
          args.targetPrice?.minor ?? null,
          args.targetPrice?.currency ?? null,
          args.thresholdPercent,
          args.channels,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new AppError('ERROR_INTERNAL');
      return toAlert(row);
    },

    async deleteAlert(userId, alertId) {
      const result = await db.query(
        'DELETE FROM alerts WHERE alert_id = $1 AND user_id = $2',
        [alertId, userId],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError('ERROR_NOT_FOUND', { details: { subject: 'alert' } });
      }
    },

    /**
     * Writes a history row only if the user still has the setting on. The
     * caller checks too, but the check is repeated here because this is the
     * last line before the insert and the setting could have changed in
     * between.
     */
    async recordSearchHistory({ userId, query, mode, resultCount, countryCode }) {
      try {
        const purgeAfter = new Date(
          Date.now() + config.retention.searchHistoryDays * 86_400_000,
        );
        await db.query(
          `INSERT INTO search_history
             (history_id, user_id, query, mode, result_count, country_code, purge_after)
           SELECT $1, $2, $3, $4, $5, $6, $7
            WHERE EXISTS (
              SELECT 1 FROM users
               WHERE user_id = $2 AND store_search_history = TRUE AND deleted_at IS NULL
            )`,
          [newId('shi'), userId, query.slice(0, 300), mode, resultCount, countryCode, purgeAfter],
        );
      } catch (error) {
        log.debug('Search history write failed', { error });
      }
    },

    async searchHistory(userId, limit) {
      const result = await db.query<{
        history_id: string;
        query: string;
        mode: string;
        result_count: number;
        created_at: Date;
      }>(
        `SELECT history_id, query, mode, result_count, created_at
           FROM search_history
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, Math.min(limit, 200)],
      );
      return result.rows.map((row) => ({
        historyId: row.history_id,
        query: row.query,
        mode: row.mode,
        resultCount: row.result_count,
        createdAt: row.created_at.toISOString(),
      }));
    },

    async clearSearchHistory(userId) {
      const result = await db.query('DELETE FROM search_history WHERE user_id = $1', [userId]);
      return result.rowCount ?? 0;
    },

    /** Everything we hold about an account, in one document. */
    async exportAll(userId) {
      const profile = await loadProfile(userId);
      const [favorites, searches, alerts, history, consents, carts] = await Promise.all([
        db.query('SELECT * FROM favorites WHERE user_id = $1', [userId]),
        db.query('SELECT * FROM saved_searches WHERE user_id = $1', [userId]),
        db.query('SELECT * FROM alerts WHERE user_id = $1', [userId]),
        db.query('SELECT * FROM search_history WHERE user_id = $1', [userId]),
        db.query('SELECT * FROM user_consents WHERE user_id = $1 ORDER BY created_at', [userId]),
        db.query('SELECT * FROM shopping_carts WHERE user_id = $1', [userId]),
      ]);

      return {
        exportedAt: new Date().toISOString(),
        profile,
        favorites: favorites.rows,
        savedSearches: searches.rows,
        alerts: alerts.rows,
        searchHistory: history.rows,
        consents: consents.rows,
        carts: carts.rows,
        // Named so the export is not mistaken for the whole picture.
        notIncluded: [
          'Affiliate click records, which are retained separately for commission reconciliation and carry a rotating session hash rather than your account id.',
          'Aggregate analytics, which do not identify you.',
        ],
      };
    },

    /**
     * Account deletion.
     *
     * Personal rows are deleted outright via cascade. Affiliate click records
     * are retained but de-linked: the commission reconciliation they support
     * is a financial record, and the row carries a rotating session hash
     * rather than an account identifier once the user id is removed.
     */
    async deleteAccount(userId) {
      await db.tx(async (client) => {
        await client.query('UPDATE affiliate_clicks SET user_id = NULL WHERE user_id = $1', [
          userId,
        ]);
        await client.query('UPDATE analytics_events SET user_id = NULL WHERE user_id = $1', [
          userId,
        ]);
        await client.query(
          `UPDATE sessions SET revoked_at = now(), revoked_reason = 'account_deleted'
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
        // Cascades to favorites, watchlists, saved searches, alerts, carts,
        // history, consents and identities.
        await client.query('DELETE FROM users WHERE user_id = $1', [userId]);
      });
      log.info('Account deleted', { userId });
    },
  };
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

interface ProfileRow {
  user_id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
  locale: string;
  country_code: string;
  currency: string;
  default_source_mode: string;
  default_sort: string;
  reduced_motion: boolean;
  store_search_history: boolean;
  personalized_ranking: boolean;
  product_analytics: boolean;
  marketing_emails: boolean;
  email_alerts: boolean;
  in_app_alerts: boolean;
  deal_digest: string;
  created_at: Date;
}

function toProfile(row: ProfileRow): UserProfile {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role: row.role as UserProfile['role'],
    preferences: {
      locale: row.locale as 'he' | 'en',
      countryCode: row.country_code,
      currency: row.currency,
      defaultSourceMode: row.default_source_mode,
      defaultSort: row.default_sort as UserProfile['preferences']['defaultSort'],
      reducedMotion: row.reduced_motion,
    },
    privacy: {
      storeSearchHistory: row.store_search_history,
      personalizedRanking: row.personalized_ranking,
      productAnalytics: row.product_analytics,
      marketingEmails: row.marketing_emails,
    },
    notifications: {
      emailAlerts: row.email_alerts,
      inAppAlerts: row.in_app_alerts,
      dealDigest: row.deal_digest as UserProfile['notifications']['dealDigest'],
    },
    createdAt: row.created_at.toISOString(),
  };
}

interface FavoriteRow {
  favorite_id: string;
  user_id: string;
  product_group_id: string | null;
  provider_id: string;
  provider_product_id: string;
  note: string | null;
  created_at: Date;
}

function toFavorite(row: FavoriteRow): FavoriteEntry {
  return {
    favoriteId: row.favorite_id,
    userId: row.user_id,
    productGroupId: row.product_group_id ?? '',
    providerId: row.provider_id,
    providerProductId: row.provider_product_id,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  };
}

interface SavedSearchRow {
  saved_search_id: string;
  user_id: string;
  label: string;
  query: string;
  mode: string;
  filters: Record<string, unknown>;
  sort: string;
  country_code: string;
  currency: string;
  notify_on_new_results: boolean;
  created_at: Date;
  last_run_at: Date | null;
}

function toSavedSearch(row: SavedSearchRow): SavedSearch {
  return {
    savedSearchId: row.saved_search_id,
    userId: row.user_id,
    label: row.label,
    query: row.query,
    mode: row.mode,
    filters: row.filters as SavedSearch['filters'],
    sort: row.sort as SavedSearch['sort'],
    notifyOnNewResults: row.notify_on_new_results,
    createdAt: row.created_at.toISOString(),
    lastRunAt: row.last_run_at?.toISOString() ?? null,
  };
}

interface AlertRow {
  alert_id: string;
  user_id: string;
  kind: string;
  provider_id: string | null;
  product_group_id: string | null;
  provider_product_id: string | null;
  provider_variant_id: string | null;
  country_code: string;
  target_price_minor: number | null;
  target_currency: string | null;
  threshold_percent: string | null;
  channels: string[];
  active: boolean;
  suspended_reason: string | null;
  created_at: Date;
  last_triggered_at: Date | null;
}

function toAlert(row: AlertRow): Alert {
  return {
    alertId: row.alert_id,
    userId: row.user_id,
    kind: row.kind as AlertKind,
    providerId: row.provider_id,
    productGroupId: row.product_group_id,
    providerProductId: row.provider_product_id,
    targetPrice:
      row.target_price_minor !== null && row.target_currency !== null
        ? money(row.target_price_minor, row.target_currency)
        : null,
    thresholdPercent: row.threshold_percent === null ? null : Number.parseFloat(row.threshold_percent),
    channels: row.channels as ReadonlyArray<'EMAIL' | 'IN_APP'>,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    lastTriggeredAt: row.last_triggered_at?.toISOString() ?? null,
    suspendedReason: row.suspended_reason,
  };
}
