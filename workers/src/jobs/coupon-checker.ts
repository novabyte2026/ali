import { createCouponStore, resolveStatus } from '@shelf/backend';
import type { JobContext, JobDefinition, JobResult } from '../runner.js';

/**
 * Coupon checker.
 *
 * Keeps coupon verification states honest over time. A coupon marked VERIFIED
 * last week is not verified now, and this job is what moves it down the ladder
 * — to RECENTLY_CHECKED, then POSSIBLY_ACTIVE — and flips a past-expiry code to
 * EXPIRED (rule 15).
 *
 * It does not re-verify codes against providers: that requires each
 * programme's authorized verification endpoint, which is not configured until a
 * programme contract exists. So for now the job performs the time-based status
 * decay that needs no external call, and the places that would issue a live
 * check are marked. Running it is still correct and necessary — a stale
 * VERIFIED badge is exactly the kind of quiet dishonesty the product avoids.
 */
export const couponCheckerJob: JobDefinition = {
  name: 'coupon-checker',
  intervalMs: 30 * 60 * 1000,
  initialDelayMs: 90 * 1000,
  lockTtlMs: 10 * 60 * 1000,

  async run(ctx: JobContext): Promise<JobResult> {
    const store = createCouponStore(ctx.db, ctx.log);

    // First, flip anything past its stated expiry. Read-time resolution hides
    // these from users already, but doing it in the table keeps admin counts
    // honest and the status index useful.
    const expired = await store.markExpired();

    // Then recompute the time-based status for coupons due a check. The status
    // is derived from last_checked_at, so re-resolving and writing it back is
    // the decay step.
    const due = await store.needingCheck(200, 30);
    let processed = 0;
    let failures = 0;

    for (const coupon of due) {
      if (ctx.signal.aborted) break;
      try {
        const resolved = resolveStatus(coupon);
        if (resolved !== coupon.status) {
          await ctx.db.query(
            `UPDATE coupons SET status = $2, updated_at = now() WHERE coupon_id = $1`,
            [coupon.couponId, resolved],
          );
        }
        processed += 1;
      } catch (error) {
        failures += 1;
        ctx.log.warn('Coupon status update failed', { couponId: coupon.couponId, error });
      }
    }

    return {
      itemsProcessed: processed + expired,
      itemsFailed: failures,
      detail: { expired, decayed: processed },
    };
  },
};
