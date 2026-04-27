-- 0033_activity_actor_type.sql — M8.A.0.fix.2 — extend `activity.actorType`
-- per plan v2 §7.1 #7 (closes M8.A.0 gap).
--
-- Mirrors `notificationOutbox.recipientKind` (migration 0032). actorType
-- distinguishes WHO performed the audited action:
--   - `user`    — internal operator/staff (existing M7 behaviour)
--   - `guest`   — public-widget customer (NEW for M8.B onwards)
--   - `system`  — automated workflow (CDC, cron, retry handler)
--   - `channel` — channel-manager / OTA push (NEW for M8.C onwards)
--
-- Existing rows get NULL — reads fall back to `user` per backwards-compat
-- semantics. New activity-writers SHOULD set explicitly; CDC consumer
-- defaults to 'system' since it's automated.

ALTER TABLE activity ADD COLUMN actorType Utf8;
