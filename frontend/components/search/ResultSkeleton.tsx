import styles from './ResultSkeleton.module.css';

/**
 * Loading skeleton.
 *
 * Shaped like the real card — same image square, same two title lines, same
 * price and cost rows — so the page does not jump when results arrive
 * (rules 54, 191). A generic grey block would reserve the wrong height and
 * reintroduce the layout shift it was meant to prevent.
 */
export function ResultSkeleton({ count = 4 }: { readonly count?: number }) {
  return (
    <div className={styles.list} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={styles.card}>
          <div className={`${styles.image} skeleton`} />
          <div className={styles.body}>
            <div className={styles.badgeRow}>
              <div className={`${styles.badge} skeleton`} />
              <div className={`${styles.badge} skeleton`} />
            </div>
            <div className={`${styles.titleLine} skeleton`} />
            <div className={`${styles.titleLineShort} skeleton`} />
            <div className={`${styles.price} skeleton`} />
            <div className={`${styles.costLine} skeleton`} />
            <div className={`${styles.costLine} skeleton`} />
            <div className={styles.actionRow}>
              <div className={`${styles.action} skeleton`} />
              <div className={`${styles.actionSmall} skeleton`} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
