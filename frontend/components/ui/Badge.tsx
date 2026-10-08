import type { ReactNode } from 'react';
import styles from './Badge.module.css';
import type { DatumTone } from '@/lib/datum';
import { CautionIcon, UnknownIcon, VerifiedIcon } from './Icon';

/**
 * Badge.
 *
 * `tone` is driven by the Datum state rather than chosen per call site, so a
 * ranged figure looks the same everywhere it appears and an unknown is never
 * dressed up as a known.
 */

export type BadgeTone =
  | DatumTone
  | 'problem'
  | 'neutral'
  | 'accent'
  | 'source';

interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly size?: 'sm' | 'lg';
  readonly plain?: boolean;
  readonly icon?: boolean;
  readonly title?: string;
  readonly children: ReactNode;
}

export function Badge({
  tone = 'neutral',
  size = 'sm',
  plain = false,
  icon = false,
  title,
  children,
}: BadgeProps) {
  const className = [
    styles.badge,
    styles[tone],
    size === 'lg' ? styles.lg : '',
    plain ? styles.plain : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={className} {...(title ? { title } : {})}>
      {icon ? toneIcon(tone) : null}
      {children}
    </span>
  );
}

/**
 * Icons are opt-in. On a dense result card the text alone is clearer, and a
 * row of small glyphs reads as decoration — which is the thing to avoid.
 */
function toneIcon(tone: BadgeTone): ReactNode {
  switch (tone) {
    case 'known':
      return <VerifiedIcon />;
    case 'estimated':
      return <CautionIcon />;
    case 'unknown':
    case 'restricted':
      return <UnknownIcon />;
    default:
      return null;
  }
}

/** Source badge. Text unless brand-mark permission is recorded in policy. */
export function SourceBadge({
  displayName,
  logoPermitted,
  logoAssetPath,
}: {
  readonly displayName: string;
  readonly logoPermitted: boolean;
  readonly logoAssetPath: string | null;
}) {
  // No permission means no mark — not a lookalike, not an approximation.
  if (logoPermitted && logoAssetPath) {
    return (
      <span className={`${styles.badge} ${styles.source}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoAssetPath} alt={displayName} height={13} />
      </span>
    );
  }
  return <Badge tone="source">{displayName}</Badge>;
}
