'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { EmptyPanel, ErrorState } from '@/components/search/EmptyState';
import {
  ApiError,
  type AuthState,
  apiRequest,
  fetchAuthState,
  signOut,
  startGoogleSignIn,
} from '@/lib/api';
import styles from './AccountView.module.css';

/**
 * Account page.
 *
 * Doubles as the sign-in page, because the only reason to sign in to this
 * product is to use the things this page holds. The guest view says exactly
 * that: search and comparison work fully without an account, and signing in
 * adds saving, alerts and baskets. No dark pattern, no gate in front of the
 * thing the product is for (rule 34).
 *
 * The privacy section is the honest centrepiece. Everything is off by default,
 * the page says so, and turning search history off deletes what was stored
 * rather than only stopping new writes.
 */

interface Favorite {
  readonly favoriteId: string;
  readonly providerId: string;
  readonly providerProductId: string;
}

interface Alert {
  readonly alertId: string;
  readonly kind: string;
  readonly providerId: string | null;
  readonly active: boolean;
  readonly suspendedReason: string | null;
}

export function AccountView() {
  const { dict } = useLocale();

  const [auth, setAuth] = useState<AuthState | null>(null);
  const [favorites, setFavorites] = useState<ReadonlyArray<Favorite>>([]);
  const [alerts, setAlerts] = useState<ReadonlyArray<Alert>>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    const controller = new AbortController();

    void fetchAuthState(controller.signal)
      .then((state) => {
        setAuth(state);
        if (!state.authenticated) return;

        void apiRequest<{ favorites: ReadonlyArray<Favorite> }>('/api/v1/me/favorites', {
          signal: controller.signal,
        })
          .then((response) => setFavorites(response.favorites))
          .catch(() => setFavorites([]));

        void apiRequest<{ alerts: ReadonlyArray<Alert> }>('/api/v1/me/alerts', {
          signal: controller.signal,
        })
          .then((response) => setAlerts(response.alerts))
          .catch(() => setAlerts([]));
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError) setError(caught);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  const updatePrivacy = async (patch: Record<string, boolean>): Promise<void> => {
    setSaving(true);
    try {
      const response = await apiRequest<{ profile: NonNullable<AuthState['profile']> }>(
        '/api/v1/me/privacy',
        { method: 'PATCH', body: patch },
      );
      setAuth((current) => (current ? { ...current, profile: response.profile } : current));
    } catch (caught) {
      if (caught instanceof ApiError) setError(caught);
    } finally {
      setSaving(false);
    }
  };

  if (error && !auth) {
    return (
      <div className="page-narrow">
        <ErrorState messageKey={error.messageKey} requestId={error.requestId} onRetry={load} />
      </div>
    );
  }

  // --- Guest view ---------------------------------------------------------
  if (auth && !auth.authenticated) {
    return (
      <div className="page-narrow">
        <PageHeader title={dict.account.heading} lead={dict.account.guestNote} />

        <div className={styles.signInPanel}>
          <p className={styles.signInNote}>{dict.account.signInNote}</p>

          {auth.signInAvailable ? (
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                void startGoogleSignIn(window.location.pathname)
                  .then((response) => {
                    window.location.href = response.authorizationUrl;
                  })
                  .catch((caught: unknown) => {
                    if (caught instanceof ApiError) setError(caught);
                  });
              }}
            >
              {dict.account.signInWithGoogle}
            </Button>
          ) : (
            // Honest about the deployment state rather than showing a button
            // that cannot work.
            <EmptyPanel message={dict.errors.ERROR_SOURCE_NOT_CONFIGURED} />
          )}
        </div>
      </div>
    );
  }

  if (!auth?.profile) {
    return (
      <div className="page-narrow">
        <div className={`${styles.loading} skeleton`} aria-hidden="true" />
      </div>
    );
  }

  const { profile } = auth;

  return (
    <div className="page-narrow">
      <PageHeader
        title={dict.account.heading}
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void signOut().then(() => window.location.reload());
            }}
          >
            {dict.nav.signOut}
          </Button>
        }
      />

      <div className={styles.sections}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{dict.account.saved}</h2>
          {favorites.length === 0 ? (
            <EmptyPanel message={dict.empty.noFavorites} />
          ) : (
            <ul className={styles.list}>
              {favorites.map((favorite) => (
                <li key={favorite.favoriteId} className={styles.listItem}>
                  <span className={styles.mono}>{favorite.providerProductId}</span>
                  <span className={styles.listMeta}>{favorite.providerId}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{dict.account.alerts}</h2>
          {alerts.length === 0 ? (
            <EmptyPanel message={dict.empty.noAlerts} />
          ) : (
            <ul className={styles.list}>
              {alerts.map((alert) => (
                <li key={alert.alertId} className={styles.listItem}>
                  <span>{alert.kind}</span>
                  <span className={styles.listMeta}>{alert.providerId}</span>
                  {/* A suspended alert is surfaced, not hidden: an alert that
                   * stopped working is worth knowing about. */}
                  {alert.suspendedReason ? (
                    <span className={styles.suspended}>{alert.suspendedReason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{dict.account.privacy}</h2>
          <p className={styles.sectionNote}>{dict.account.privacyNote}</p>

          <div className={styles.toggles}>
            <Toggle
              label={dict.account.storeSearchHistory}
              checked={profile.privacy.storeSearchHistory ?? false}
              disabled={saving}
              onChange={(value) => void updatePrivacy({ storeSearchHistory: value })}
            />
            <Toggle
              label={dict.account.personalizedRanking}
              checked={profile.privacy.personalizedRanking ?? false}
              disabled={saving}
              onChange={(value) => void updatePrivacy({ personalizedRanking: value })}
            />
            <Toggle
              label={dict.account.productAnalytics}
              checked={profile.privacy.productAnalytics ?? false}
              disabled={saving}
              onChange={(value) => void updatePrivacy({ productAnalytics: value })}
            />
            <Toggle
              label={dict.account.marketingEmails}
              checked={profile.privacy.marketingEmails ?? false}
              disabled={saving}
              onChange={(value) => void updatePrivacy({ marketingEmails: value })}
            />
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{dict.account.exportData}</h2>
          <p className={styles.sectionNote}>{dict.account.exportNote}</p>
          <Button as="external" href="/api/v1/me/export" variant="secondary" size="sm">
            {dict.account.exportData}
          </Button>
        </section>

        <section className={`${styles.section} ${styles.danger}`}>
          <h2 className={styles.sectionTitle}>{dict.account.deleteAccount}</h2>
          <p className={styles.sectionNote}>{dict.account.deleteWarning}</p>
          <DeleteAccount email={profile.email} />
        </section>
      </div>
    </div>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Account deletion.
 *
 * Requires typing the account's own e-mail. The server checks it too — this
 * is a confirmation step, not a security control, and it is here because
 * deletion is irreversible and a single misplaced click should not do it.
 */
function DeleteAccount({ email }: { readonly email: string }) {
  const { dict } = useLocale();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const matches = value.trim().toLowerCase() === email.toLowerCase();

  return (
    <div className={styles.deleteBlock}>
      <label className={styles.deleteLabel}>
        <span>{dict.account.deleteConfirmLabel}</span>
        <input
          className={styles.deleteInput}
          type="email"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <Button
        variant="danger"
        size="sm"
        disabled={!matches || busy}
        onClick={() => {
          setBusy(true);
          setFailed(false);
          void apiRequest('/api/v1/me/delete', {
            method: 'POST',
            body: { confirmEmail: value.trim() },
          })
            .then(() => {
              window.location.href = '/';
            })
            .catch(() => {
              setFailed(true);
              setBusy(false);
            });
        }}
      >
        {dict.account.deleteConfirm}
      </Button>

      {failed ? <p className={styles.deleteError}>{dict.errors.ERROR_INTERNAL}</p> : null}
    </div>
  );
}
