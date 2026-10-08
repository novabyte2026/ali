'use client';

import type { CouponStatus, NormalizedCoupon } from '@shelf/shared';
import { useLocale } from '@/components/LocaleProvider';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CheckIcon, CopyIcon } from '@/components/ui/Icon';
import { useCopy } from '@/lib/hooks';
import { formatDate, relativeTime } from '@/lib/datum';
import styles from './CouponCard.module.css';

/**
 * Coupon card.
 *
 * The verification state is the most prominent thing on the card after the
 * code itself, and the conditions are listed rather than buried in terms
 * (rule 15). "Possibly active" is a legitimate thing to show — most coupon
 * data is exactly that — but it has to look different from "verified", and a
 * user has to be able to tell at a glance which one they are looking at.
 *
 * There is no "guaranteed discount" language anywhere, and no countdown.
 */

export interface CouponWithTrust extends NormalizedCoupon {
  readonly trust: {
    readonly statusKey: string;
    readonly methodKey: string;
    readonly checkedAt: string | null;
    readonly conditionKeys: ReadonlyArray<string>;
  };
}

export function CouponCard({
  coupon,
  providerName,
}: {
  readonly coupon: CouponWithTrust;
  readonly providerName: string;
}) {
  const { dict, locale } = useLocale();
  const { copied, copy } = useCopy();

  const tone = toneForStatus(coupon.status);
  const expiry =
    coupon.expiresAt.state === 'KNOWN' ? formatDate(coupon.expiresAt.value, locale) : null;

  const discountLabel =
    coupon.discountPercent.state === 'KNOWN'
      ? `${coupon.discountPercent.value}%`
      : coupon.discountAmount.state === 'KNOWN'
        ? `${coupon.discountAmount.value.minor / 100} ${coupon.discountAmount.value.currency}`
        : null;

  return (
    <article className={styles.card}>
      <div className={styles.top}>
        <Badge tone="source">{providerName}</Badge>
        <Badge tone={tone} icon>
          {dict.coupon.status[coupon.status]}
        </Badge>
      </div>

      <h3 className={styles.title}>{coupon.title}</h3>

      {discountLabel ? <div className={styles.discount}>{discountLabel}</div> : null}

      {coupon.code ? (
        <div className={styles.codeRow}>
          <code className={styles.code}>{coupon.code}</code>
          <Button
            variant={copied ? 'subtle' : 'secondary'}
            size="sm"
            onClick={() => void copy(coupon.code as string)}
            aria-live="polite"
          >
            {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
            {copied ? dict.coupon.copied : dict.coupon.copy}
          </Button>
        </div>
      ) : null}

      {/* Why this status, in one line. The user should never have to guess
       * what "possibly active" rests on. */}
      <p className={styles.statusNote}>{dict.coupon.statusNote[coupon.status]}</p>

      {coupon.trust.conditionKeys.length > 0 ? (
        <ul className={styles.conditions}>
          {coupon.trust.conditionKeys.map((key) => (
            <li key={key} className={styles.condition}>
              {conditionLabel(key, dict)}
            </li>
          ))}
        </ul>
      ) : null}

      <footer className={styles.meta}>
        <span>
          {coupon.trust.checkedAt
            ? dict.coupon.lastChecked(relativeTime(coupon.trust.checkedAt, dict) ?? '')
            : dict.coupon.neverChecked}
        </span>
        <span>{expiry ? dict.coupon.expires(expiry) : dict.coupon.noExpiry}</span>
      </footer>

      {coupon.terms ? <p className={styles.terms}>{coupon.terms}</p> : null}
    </article>
  );
}

function toneForStatus(status: CouponStatus): BadgeTone {
  switch (status) {
    case 'VERIFIED':
      return 'known';
    case 'RECENTLY_CHECKED':
      return 'known';
    case 'POSSIBLY_ACTIVE':
      return 'estimated';
    case 'EXPIRED':
    case 'INVALID':
      return 'problem';
    default:
      return 'unknown';
  }
}

function conditionLabel(key: string, dict: ReturnType<typeof useLocale>['dict']): string {
  const leaf = key.replace(/^coupon\.condition\./, '') as keyof typeof dict.coupon.condition;
  const text = dict.coupon.condition[leaf];
  return typeof text === 'string' ? text : key;
}
