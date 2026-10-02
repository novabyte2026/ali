'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '@/components/LocaleProvider';
import { useProviders } from '@/components/layout/ProvidersProvider';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/search/EmptyState';
import { ApiError, apiRequest } from '@/lib/api';
import { relativeTime } from '@/lib/datum';
import styles from './AdminView.module.css';

/**
 * Admin console.
 *
 * The Compliance Center is the reason this console exists: it answers, per
 * provider, what we are currently claiming we may do, when that was last
 * checked by a human, and what is waiting on one.
 *
 * The kill switch is here and takes effect immediately. Every mutating action
 * requires a reason and writes an audit entry — a change to what the product
 * tells users about a marketplace has to be attributable afterwards (rules 200,
 * 201).
 */

interface ComplianceReport {
  readonly providerId: string;
  readonly policyVersion: string;
  readonly policyCheckedAt: string | null;
  readonly policyAgeDays: number | null;
  readonly policyStale: boolean;
  readonly capabilitiesNeedingVerification: ReadonlyArray<string>;
  readonly capabilitiesNotConfigured: ReadonlyArray<string>;
  readonly engagedKillSwitches: ReadonlyArray<string>;
  readonly disclosureConfigured: boolean;
  readonly openWarnings: number;
}

interface ComplianceResponse {
  readonly reports: ReadonlyArray<ComplianceReport>;
  readonly actionRequired: number;
}

interface HealthResponse {
  readonly live: ReadonlyArray<{
    readonly providerId: string;
    readonly runtimeState: string;
    readonly successRate1h: number | null;
    readonly p50LatencyMs: number | null;
    readonly p95LatencyMs: number | null;
    readonly circuitState: string;
  }>;
  readonly configuration: ReadonlyArray<{
    readonly providerId: string;
    readonly enabled: boolean;
    readonly fullyConfigured: boolean;
    readonly missingSettings: ReadonlyArray<string>;
    readonly servingDemoFixtures: boolean;
  }>;
}

export function AdminView() {
  const { dict } = useLocale();
  const providers = useProviders();

  const [compliance, setCompliance] = useState<ComplianceResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    const controller = new AbortController();
    setError(null);

    void apiRequest<ComplianceResponse>('/api/v1/admin/compliance', { signal: controller.signal })
      .then(setCompliance)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError) setError(caught);
      });

    void apiRequest<HealthResponse>('/api/v1/admin/source-health', { signal: controller.signal })
      .then(setHealth)
      .catch(() => setHealth(null));

    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load]);

  if (error) {
    return (
      <div className="page">
        <ErrorState messageKey={error.messageKey} requestId={error.requestId} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={dict.admin.heading}
        lead={
          compliance ? dict.admin.actionRequired(compliance.actionRequired) : undefined
        }
      />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{dict.admin.compliance}</h2>

        <div className={styles.cards}>
          {compliance?.reports.map((report) => (
            <article key={report.providerId} className={styles.card}>
              <header className={styles.cardHeader}>
                <h3 className={styles.cardTitle}>{providers.name(report.providerId)}</h3>
                <Badge tone={report.policyStale ? 'estimated' : 'known'}>
                  {report.policyStale ? dict.admin.stale : dict.admin.policyVersion}
                </Badge>
              </header>

              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>{dict.admin.policyVersion}</dt>
                  <dd className={styles.mono}>{report.policyVersion}</dd>
                </div>
                <div className={styles.fact}>
                  <dt>{dict.admin.lastChecked}</dt>
                  <dd>
                    {report.policyCheckedAt
                      ? relativeTime(report.policyCheckedAt, dict)
                      : dict.admin.never}
                  </dd>
                </div>
              </dl>

              {/* The backlog that needs a human: capabilities nobody has
               * verified against the programme's current terms. */}
              {report.capabilitiesNeedingVerification.length > 0 ? (
                <div className={styles.group}>
                  <h4 className={styles.groupTitle}>{dict.sources.pendingVerification}</h4>
                  <div className={styles.chips}>
                    {report.capabilitiesNeedingVerification.map((capability) => (
                      <Badge key={capability} tone="estimated">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {report.capabilitiesNotConfigured.length > 0 ? (
                <div className={styles.group}>
                  <h4 className={styles.groupTitle}>{dict.sources.notConfigured}</h4>
                  <div className={styles.chips}>
                    {report.capabilitiesNotConfigured.map((capability) => (
                      <Badge key={capability} tone="unknown">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {report.engagedKillSwitches.length > 0 ? (
                <div className={styles.group}>
                  <h4 className={styles.groupTitle}>{dict.admin.killSwitch}</h4>
                  <div className={styles.chips}>
                    {report.engagedKillSwitches.map((capability) => (
                      <Badge key={capability} tone="problem">
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              <footer className={styles.cardFooter}>
                {!report.disclosureConfigured ? (
                  <Badge tone="problem">{dict.errors.ERROR_DISCLOSURE_NOT_CONFIGURED}</Badge>
                ) : null}
                {report.openWarnings > 0 ? (
                  <span className={styles.warningCount}>{report.openWarnings}</span>
                ) : null}
              </footer>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>{dict.admin.sourceHealth}</h2>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{dict.comparison.store}</th>
                <th scope="col">{dict.admin.successRate}</th>
                <th scope="col">{dict.admin.latency}</th>
                <th scope="col">{dict.admin.circuit}</th>
                <th scope="col">{dict.sources.notConfigured}</th>
              </tr>
            </thead>
            <tbody>
              {(health?.configuration ?? []).map((config) => {
                const live = health?.live.find(
                  (entry) => entry.providerId === config.providerId,
                );
                return (
                  <tr key={config.providerId}>
                    <th scope="row">
                      {providers.name(config.providerId)}
                      {config.servingDemoFixtures ? (
                        <Badge tone="estimated">{dict.demo.label}</Badge>
                      ) : null}
                    </th>
                    <td className={styles.numeric}>
                      {live?.successRate1h === null || live === undefined
                        ? '—'
                        : `${Math.round(live.successRate1h * 100)}%`}
                    </td>
                    <td className={styles.numeric}>
                      {live?.p50LatencyMs !== null && live?.p50LatencyMs !== undefined
                        ? `${live.p50LatencyMs} / ${live.p95LatencyMs ?? '—'} ms`
                        : '—'}
                    </td>
                    <td>{live?.circuitState ?? '—'}</td>
                    <td className={styles.missingCell}>
                      {/* Setting names only — never a value. */}
                      {config.missingSettings.length > 0
                        ? config.missingSettings.join(', ')
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
