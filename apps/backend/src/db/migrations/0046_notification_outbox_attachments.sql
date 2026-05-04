-- 0046_notification_outbox_attachments.sql — M9.widget.5 / A3.2.b
-- Add attachmentsJson column to notificationOutbox для .ics + future PDF voucher
-- attachments. Column nullable (existing rows + non-attachment kinds skip).
--
-- Schema: JSON array of `[{ filename, content (base64), contentType }, ...]`.
-- Dispatcher reads + parses + passes к email-adapter Send command.
--
-- Per `plans/m9_widget_5_canonical.md` §D8 + §10 step 11-12: dispatcher CDC
-- consumer для booking.created event → rich voucher email с .ics attachment.

ALTER TABLE notificationOutbox ADD COLUMN attachmentsJson Json;
