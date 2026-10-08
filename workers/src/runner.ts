import { newId } from '@shelf/shared';
import type { Database, Logger } from '@shelf/backend';

/**
 * Job runner.
 *
 * Deliberately simple: an interval scheduler with a database-backed advisory
 * lock, rather than a queue library. The jobs here are periodic sweeps, not a
 * work queue — nothing enqueues them, they run on a clock — and a lock plus a
 * run log is the whole requirement.
 *
 * The lock matters in any deployment with more than one worker instance: two
 * coupon checkers running concurrently would double the request volume against
 * a provider's quota, which is the one resource we genuinely cannot overspend.
 */

export interface JobContext {
  readonly db: Database;
  readonly log: Logger;
  readonly signal: AbortSignal;
}

export interface JobResult {
  readonly itemsProcessed: number;
  readonly itemsFailed: number;
  readonly detail?: Record<string, unknown>;
}

export interface JobDefinition {
  readonly name: string;
  /** How often to run, in milliseconds. */
  readonly intervalMs: number;
  /** Delay before the first run, so a boot does not fire everything at once. */
  readonly initialDelayMs: number;
  /** Lock hold time. Must exceed the job's realistic worst-case duration. */
  readonly lockTtlMs: number;
  run(ctx: JobContext): Promise<JobResult>;
}

export class JobRunner {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly controller = new AbortController();
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly log: Logger,
    private readonly holderId: string = newId('worker'),
  ) {}

  start(jobs: ReadonlyArray<JobDefinition>): void {
    for (const job of jobs) {
      const schedule = (delay: number): void => {
        if (this.stopped) return;
        const timer = setTimeout(() => {
          void this.execute(job).finally(() => schedule(job.intervalMs));
        }, delay);
        // Unref so a pending timer does not hold the process open during a
        // graceful shutdown.
        timer.unref();
        this.timers.set(job.name, timer);
      };

      schedule(job.initialDelayMs);
      this.log.info('Scheduled job', {
        job: job.name,
        intervalMs: job.intervalMs,
        firstRunInMs: job.initialDelayMs,
      });
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.controller.abort();

    // Give in-flight jobs a moment to notice the abort and release their lock
    // rather than leaving it to expire.
    const deadline = Date.now() + 5000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async execute(job: JobDefinition): Promise<void> {
    if (this.stopped) return;

    // In-process guard for a job that overran its own interval.
    if (this.running.has(job.name)) {
      this.log.warn('Job still running, skipping this tick', { job: job.name });
      return;
    }

    const acquired = await this.acquireLock(job.name, job.lockTtlMs);
    if (!acquired) {
      this.log.debug('Job lock held elsewhere, skipping', { job: job.name });
      return;
    }

    this.running.add(job.name);
    const runId = newId('run');
    const startedAt = Date.now();

    await this.db
      .query('INSERT INTO job_runs (run_id, job_name, status) VALUES ($1, $2, $3)', [
        runId,
        job.name,
        'RUNNING',
      ])
      .catch(() => undefined);

    try {
      const result = await job.run({
        db: this.db,
        log: this.log.child({ job: job.name, runId }),
        signal: this.controller.signal,
      });

      const durationMs = Date.now() - startedAt;
      await this.db.query(
        `UPDATE job_runs
            SET status = $2, finished_at = now(), duration_ms = $3,
                items_processed = $4, items_failed = $5, detail = $6
          WHERE run_id = $1`,
        [
          runId,
          result.itemsFailed > 0 ? 'PARTIAL' : 'SUCCEEDED',
          durationMs,
          result.itemsProcessed,
          result.itemsFailed,
          JSON.stringify(result.detail ?? {}),
        ],
      );

      this.log.info('Job finished', {
        job: job.name,
        durationMs,
        processed: result.itemsProcessed,
        failed: result.itemsFailed,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.db
        .query(
          `UPDATE job_runs
              SET status = 'FAILED', finished_at = now(), duration_ms = $2, error_code = $3
            WHERE run_id = $1`,
          [runId, durationMs, error instanceof Error ? error.name : 'UnknownError'],
        )
        .catch(() => undefined);

      // A failing job must not take the worker process down with it; the next
      // tick gets a clean attempt.
      this.log.error('Job failed', { job: job.name, error });
    } finally {
      this.running.delete(job.name);
      await this.releaseLock(job.name);
    }
  }

  /**
   * Takes the lock, or takes over one whose holder died.
   *
   * The expiry is what makes a crashed worker recoverable without manual
   * intervention: the row stays behind, but the next worker reclaims it once
   * the TTL passes.
   */
  private async acquireLock(jobName: string, ttlMs: number): Promise<boolean> {
    try {
      const result = await this.db.query(
        `INSERT INTO job_locks (job_name, holder, expires_at)
         VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)
         ON CONFLICT (job_name) DO UPDATE
           SET holder = EXCLUDED.holder,
               acquired_at = now(),
               expires_at = EXCLUDED.expires_at
         WHERE job_locks.expires_at < now()`,
        [jobName, this.holderId, String(ttlMs)],
      );
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      this.log.warn('Could not acquire job lock', { job: jobName, error });
      return false;
    }
  }

  private async releaseLock(jobName: string): Promise<void> {
    await this.db
      .query('DELETE FROM job_locks WHERE job_name = $1 AND holder = $2', [
        jobName,
        this.holderId,
      ])
      .catch(() => undefined);
  }
}
