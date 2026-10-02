import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

/**
 * Shared page heading.
 *
 * One h1, an optional lead paragraph, and a slot for controls. Having this in
 * one place is what keeps the vertical rhythm identical across Coupons, Deals,
 * Account and the legal pages — the kind of consistency that is invisible when
 * it is right and obvious when it is not.
 */
export function PageHeader({
  title,
  lead,
  actions,
}: {
  readonly title: string;
  readonly lead?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.text}>
        <h1 className={styles.title}>{title}</h1>
        {lead ? <p className={styles.lead}>{lead}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}
