-- 0059_channel_broadcast_consumer.sql — M10 / A7.5
--
-- Adds `channel_broadcast_writer` consumer on `booking/booking_events` topic.
-- Each booking INSERT projects к per-channel `channelDispatch` row fan-out
-- via `createChannelBroadcastHandler` (workers/handlers/channel-broadcast.ts).
--
-- Multi-consumer canon на single topic — proven pattern: `booking_events`
-- already has `activity_writer` + `notification_writer` + `folio_creator_writer`
-- + `migration_registration_enqueuer` + `tourism_tax_writer` + `cancel_fee_writer`.
-- Each consumer maintains independent commit cursor; gas pedal fan-out.

ALTER TOPIC `booking/booking_events` ADD CONSUMER `channel_broadcast_writer`;
