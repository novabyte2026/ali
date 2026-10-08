import type { JobContext, JobDefinition, JobResult } from '../runner.js';

/**
 * Notification dispatcher.
 *
 * Drains the notification outbox. In-app notifications are delivered by
 * marking them sent — they are read from the database by the app, so "delivery"
 * is just the state change. E-mail delivery requires SMTP configuration; when
 * the mail driver is console (the development default) the job logs the message
 * and marks it sent so the outbox does not back up, which is honest for dev and
 * refused for production at config load.
 *
 * The outbox pattern is deliberate: a notification is written in the same
 * transaction as the event that caused it, then delivered here, so a crash
 * between the two cannot lose a user's price alert.
 */
export const notificationDispatcherJob: JobDefinition = {
  name: 'notification-dispatcher',
  intervalMs: 60 * 1000,
  initialDelayMs: 15 * 1000,
  lockTtlMs: 2 * 60 * 1000,

  async run(ctx: JobContext): Promise<JobResult> {
    const pending = await ctx.db.query<{
      notification_id: string;
      channel: string;
      template: string;
      attempts: number;
    }>(
      `SELECT notification_id, channel, template, attempts
         FROM notification_outbox
        WHERE status = 'PENDING' AND send_after <= now()
        ORDER BY created_at
        LIMIT 100`,
    );

    let sent = 0;
    let failed = 0;

    for (const row of pending.rows) {
      if (ctx.signal.aborted) break;
      try {
        if (row.channel === 'IN_APP') {
          // Already materialized as an alert_event row the app reads; here we
          // only mark the outbox entry done.
          await ctx.db.query(
            `UPDATE notification_outbox SET status = 'SENT', sent_at = now()
              WHERE notification_id = $1`,
            [row.notification_id],
          );
          sent += 1;
        } else if (row.channel === 'EMAIL') {
          const driver = process.env.MAIL_DRIVER ?? 'console';
          if (driver === 'console') {
            ctx.log.info('Email (console driver)', {
              notificationId: row.notification_id,
              template: row.template,
            });
            await ctx.db.query(
              `UPDATE notification_outbox SET status = 'SENT', sent_at = now()
                WHERE notification_id = $1`,
              [row.notification_id],
            );
            sent += 1;
          } else {
            // A real SMTP send would go here. Until it is implemented the entry
            // is left PENDING and retried rather than silently marked sent,
            // because marking an undelivered alert as sent is the kind of lie
            // this product avoids.
            await ctx.db.query(
              `UPDATE notification_outbox
                  SET attempts = attempts + 1,
                      send_after = now() + INTERVAL '5 minutes',
                      last_error = 'SMTP delivery not implemented'
                WHERE notification_id = $1`,
              [row.notification_id],
            );
            failed += 1;
          }
        }
      } catch (error) {
        failed += 1;
        // After five attempts, give up and mark it failed so the outbox does
        // not retry forever.
        await ctx.db
          .query(
            `UPDATE notification_outbox
                SET attempts = attempts + 1,
                    status = CASE WHEN attempts + 1 >= 5 THEN 'FAILED' ELSE 'PENDING' END,
                    send_after = now() + INTERVAL '5 minutes',
                    last_error = $2
              WHERE notification_id = $1`,
            [row.notification_id, error instanceof Error ? error.message.slice(0, 200) : 'unknown'],
          )
          .catch(() => undefined);
      }
    }

    return { itemsProcessed: sent, itemsFailed: failed, detail: { sent, failed } };
  },
};
