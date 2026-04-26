-- Migration 0024 — add lookup-by-id indexes on payment + receipt
-- (M7.fix.1, 2026-04-26).
--
-- Background:
--   payment PK is (tenantId, propertyId, bookingId, id) — 4D
--   receipt PK is (tenantId, paymentId, id)             — 3D
--   Lookup by id alone is O(N) full-scan without an index.
--
-- The notification dispatcher (`workers/notification-dispatcher.ts`) needs
-- to resolve the guest email from `sourceObjectId` at send time. The
-- resolver chain walks payment.id → bookingId → primaryGuestId → guest.email
-- (and receipt.id → paymentId → ... for receipt-source notifications).
--
-- Without these indexes the resolver would full-scan payment/receipt every
-- send, which collapses dispatcher throughput.
--
-- Same shape as `ixBookingId GLOBAL SYNC ON (id)` on the booking table —
-- added in migration 0004 for the same admin-deeplink reason.

ALTER TABLE payment ADD INDEX ixPaymentId GLOBAL SYNC ON (id);
ALTER TABLE receipt ADD INDEX ixReceiptId GLOBAL SYNC ON (id);
