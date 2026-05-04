-- M9.widget.8 / A6.1 — cron run log table.
--
-- Idempotency primitive for `Cron` handlers per
-- `plans/m9_widget_8_canonical.md` D13:
--   - Handler MUST UPSERT keyed by (jobName, runDate) — same run_date never
--     produces duplicate side-effects even if handler fires N times.
--   - Startup-check «last successful refresh >24h ago» reads MAX(runDate) by
--     jobName + compares to current UTC date.
--   - Resumable transaction-per-batch: handler may write checkpoint rows как
--     it progresses; on SIGTERM mid-flight, next tick continues from last
--     checkpoint without redo.
--
-- PK = (jobName, runDate) — natural composite. NO surrogate `id` — would
-- defeat idempotency invariant. UPSERT semantics:
--   * status='in_progress' on tick start (with attemptId for tracing)
--   * status='completed' on tick end (touches updatedAt)
--   * status='failed' if handler throws (caught by Croner `catch:` callback)
--
-- runDate is a `Date` (not `Timestamp`) — daily granularity is the contract.
-- For sub-daily crons (e.g. hourly) we'd extend (jobName, runDate, runHour).

CREATE TABLE IF NOT EXISTS cronRunLog (
    jobName     Utf8 NOT NULL,
    runDate     Date NOT NULL,
    status      Utf8 NOT NULL, -- 'in_progress' | 'completed' | 'failed'
    attemptId   Utf8 NOT NULL, -- random per-attempt id for log correlation
    startedAt   Timestamp NOT NULL,
    finishedAt  Timestamp,
    errorClass  Utf8,
    errorMessage Utf8,
    -- Optional checkpoint row counter per resumable batch handler design.
    -- E.g. demo-refresh может set checkpoint=N после batch N completes.
    checkpoint  Int32,
    PRIMARY KEY (jobName, runDate)
);
