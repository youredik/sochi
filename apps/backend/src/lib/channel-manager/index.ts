/**
 * Channel manager Foundation barrel — M10 / A7.1.
 *
 * Single import surface for adapter implementations (A7.2/A7.3/A7.4 Mock impls).
 *
 * Usage:
 *   ```ts
 *   import {
 *     type ChannelManagerAdapter,
 *     type ChannelMode,
 *     verifySignature,
 *     buildIdempotencyKey,
 *     classifyIncoming,
 *     computeAvailability,
 *     buildCloudEvent,
 *   } from 'apps/backend/src/lib/channel-manager'
 *   ```
 */

export type {
	AriDelta,
	AvailabilityQuery,
	AvailabilityRow,
	CancellationPolicy,
	ChannelManagerAdapter,
	ChannelMetadata,
	ChannelMode,
	ChannelReservation,
	ChannelRole,
	CreateBookingInput,
	ReservationReadCursor,
	VerifyBookingInput,
	VerifyBookingResult,
} from './adapter.ts'
export {
	buildIdempotencyKey,
	computeNextAttemptAt,
	DISPATCH_MAX_ATTEMPTS,
	type DispatchStatus,
	isRetryableFailure,
	shouldAutoDisable,
} from './channel-dispatch.ts'
export {
	buildCloudEvent,
	buildEventType,
	buildSourceUrn,
	idempotencyTuple,
	parseCloudEvent,
	type SochiCloudEvent,
} from './cloud-events.ts'
export { classifyIncoming, computeBodyHash, type InboxRow } from './inbox.ts'
export {
	computeAvailability,
	detectOverbooking,
	type InventoryCell,
	type InventoryDecision,
	overbookingExcess,
} from './inventory-pool.ts'
export {
	computeSignature,
	DEFAULT_REPLAY_WINDOW_SECONDS,
	ipAllowlistVerify,
	type SignatureFailure,
	type SignatureVerificationInput,
	type VerifyResult,
	verifySignature,
	type WebhookSecretSlot,
} from './standard-webhooks.ts'
