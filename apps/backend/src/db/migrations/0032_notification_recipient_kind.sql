-- 0032_notification_recipient_kind.sql — M8.A.0.6 — extend notificationOutbox
-- with recipient routing dimension. Per plan v2 §7.1 #5.
--
-- `recipientKind` ∈ {user, guest, system, channel}:
--   - `user`    — internal operator/staff (existing M7 admin notifications)
--   - `guest`   — public-widget customer (NEW for M8.B onwards)
--   - `system`  — ops alerts (PagerDuty-equivalent; no human recipient)
--   - `channel` — channel-manager / OTA endpoint
--
-- Existing rows keep `recipientKind = NULL` (no risk; service layer treats
-- NULL as `user` per backwards-compat semantics). New rows MUST set it
-- explicitly via Zod refinement at service boundary.

ALTER TABLE notificationOutbox ADD COLUMN recipientKind Utf8;
