-- =============================================================================
-- Migration 0015 — M6 Payment domain pt.9: register CDC consumers
-- =============================================================================
--
-- Mirror of 0005 (booking activity_writer) for the payment domain. YDB
-- requires consumer NAMES to be declared on a topic BEFORE a reader can
-- attach to it — per migration-order convention, we declare them here so
-- the in-process workers in apps/backend/src/workers/cdc-consumer.ts can
-- attach on first boot without a runtime CREATE.
--
-- ## Path format
--
-- `<tableName>/<changefeedName>` — YDB exposes each table changefeed as
-- a topic child under the table's scheme path.
--
-- ## Server-tier caveat (memory `project_ydb_specifics.md`)
--
-- YDB Serverless caps topic `retention_period` at 24h (verified empirically
-- by stankoff-v2 Round 3 Agent 2 on preprod, Apr 2026). Our changefeeds in
-- 0007/0008/0009/0011/0012 declare 72h which works on Dedicated + local
-- Docker; deploying to Serverless requires a future ALTER TOPIC migration
-- to shrink retention to 24h.
--
-- ## Consumers wired in M6.5 (in-process readers in apps/backend/src/workers/)
--
-- - **activity_writer** — projects every state transition into the
--   `activity` audit log table. One consumer name, attached to ALL
--   payment-domain topics (folio, payment, refund, receipt, dispute).
--
-- - **folio_balance_writer** — recomputes `folio.balanceMinor` whenever
--   a folioLine is posted/voided OR a payment lands OR a refund lands.
--   Reads folio + payment + refund topics; writes folio rows.
--
-- - **notification_writer** — emits ops emails / push notifications:
--   * payment.succeeded → guest receipt link
--   * payment.failed   → ops alert
--   * receipt.confirmed → guest QR-код email (54-ФЗ delivery)
--   * receipt.failed    → ops fiscal alert
--
-- - **payment_status_writer** — listens on refund_events; on
--   refund.status='succeeded', applies the cumulative status derivation
--   (`deriveRefundStatus`) to the parent payment: succeeded →
--   partially_refunded → refunded (canon invariant #23).
--
-- - **refund_creator_writer** — listens on dispute_events; on
--   dispute.status='lost', auto-creates compensating Refund with
--   `causalityId='dispute:<id>'` (canon invariant #15). UNIQUE on
--   `ixRefundCausality` (migration 0009) makes this idempotent under
--   replay.
--
-- ## NB: receipt + dispute consumers
--
-- Receipt and dispute changefeeds are declared in 0011 / 0012; their
-- consumer registrations land here for ALTER TOPIC sequencing (the
-- ADD CONSUMER must run AFTER the ADD CHANGEFEED, but YDB topology
-- requirements don't constrain WHICH migration declares the consumer).
--
-- ## NB: folio.folioLine has NO own changefeed
--
-- (See migration 0007 trailing comment.) Line-level state changes are
-- captured by the folio CDC consumer enriching its activity rows via a
-- read of folioLine on each folio diff. Saves one consumer slot.
--
-- =============================================================================

-- ===== folio domain =====
ALTER TOPIC `folio/folio_events` ADD CONSUMER `folio_balance_writer`;
ALTER TOPIC `folio/folio_events` ADD CONSUMER `activity_writer`;

-- ===== payment domain =====
ALTER TOPIC `payment/payment_events` ADD CONSUMER `activity_writer`;
ALTER TOPIC `payment/payment_events` ADD CONSUMER `notification_writer`;
ALTER TOPIC `payment/payment_events` ADD CONSUMER `folio_balance_writer`;

-- ===== refund domain =====
ALTER TOPIC `refund/refund_events` ADD CONSUMER `activity_writer`;
ALTER TOPIC `refund/refund_events` ADD CONSUMER `folio_balance_writer`;
ALTER TOPIC `refund/refund_events` ADD CONSUMER `payment_status_writer`;

-- ===== receipt domain =====
ALTER TOPIC `receipt/receipt_events` ADD CONSUMER `activity_writer`;
ALTER TOPIC `receipt/receipt_events` ADD CONSUMER `notification_writer`;

-- ===== dispute domain =====
ALTER TOPIC `dispute/dispute_events` ADD CONSUMER `activity_writer`;
ALTER TOPIC `dispute/dispute_events` ADD CONSUMER `refund_creator_writer`;
