/**
 * Ostrovok ETG factory — strict tests ETG-F1..ETG-F13 (Round 8 P0-1 + P0-4 + P1-5).
 *
 * Verifies httpAttempt handler invokes the resolved adapter per eventType
 * (NOT vacuous `{ok:true}` echo per Round 8 sweep finding) + reserved-test-range
 * shield (per `feedback_outbound_side_effect_discipline_2026_05_22`) + sanitized
 * error logging (no raw guest PII).
 *
 * Suite uses a fake-but-faithful `ChannelFactory` shim that captures the
 * registered handler so we can call it directly with controlled payloads.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type {
	AriDelta,
	AriPushResult,
	ChannelManagerAdapter,
	ChannelMetadata,
	ChannelReservation,
	VerifyBookingResult,
} from '../../../lib/channel-manager/adapter.ts'
import { __resetSequenceForTesting } from '../../../lib/channel-manager/sequence.ts'
import type { ChannelFactory } from '../channel.factory.ts'
import { registerOstrovokEtgWithChannelFactory } from './ostrovok-etg.factory.ts'

interface CapturedHandlers {
	adapterFactory?: (input: { readonly organizationId: string }) => Promise<ChannelManagerAdapter>
	httpAttempt?: (input: {
		readonly tenantId: string
		readonly eventType: string
		readonly idempotencyKey: string
		readonly payload: unknown
	}) => Promise<unknown>
}

function buildFakeFactory(adapter: ChannelManagerAdapter): {
	factory: ChannelFactory
	captured: CapturedHandlers
} {
	const captured: CapturedHandlers = {}
	const factory: ChannelFactory = {
		// biome-ignore lint/suspicious/noExplicitAny: test shim — narrow interface
		connectionRepo: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: test shim
		dispatchRepo: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: test shim
		inboxRepo: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: test shim
		inventoryPoolRepo: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: test shim
		secretRepo: {} as any,
		// biome-ignore lint/suspicious/noExplicitAny: test shim
		adapterCache: {} as any,
		async resolveAdapter() {
			return adapter
		},
		registerAdapterFactory(_channelId, fn) {
			captured.adapterFactory = fn
		},
		registerHttpAttempt(_channelId, handler) {
			captured.httpAttempt = handler
		},
		// biome-ignore lint/suspicious/noExplicitAny: test shim
		webhookRoutes: {} as any,
		dispatcher: null,
		async stopDispatcher() {},
	}
	return { factory, captured }
}

function buildAdapterMock(overrides: Partial<ChannelManagerAdapter> = {}): ChannelManagerAdapter {
	const metadata: ChannelMetadata = {
		channelId: 'ETG',
		mode: 'mock',
		role: 'independent_operator',
		displayName: 'ETG Mock (test)',
	}
	const defaultPushResult: AriPushResult = { accepted: 1, rejected: 0, errors: [] }
	return {
		metadata,
		async pushAri(): Promise<AriPushResult> {
			return defaultPushResult
		},
		async pushAriFull(): Promise<AriPushResult> {
			return defaultPushResult
		},
		async searchAvailability() {
			return []
		},
		async readReservations() {
			return { reservations: [] as ReadonlyArray<ChannelReservation>, hasMore: false }
		},
		async verifyBooking(): Promise<VerifyBookingResult> {
			return {
				createBookingToken: 'verify-tok-1',
				checksum: 'cs',
				expiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
				totalAmountMicros: 7_000_000n,
				cancellationPolicy: {
					referencePoint: 'GuestArrivalTime',
					hoursBeforeRef: 72,
					penaltyKind: 'first_night',
					penaltyValue: 1,
				},
			}
		},
		async createBooking() {
			return { externalId: 'etg-ext-1' }
		},
		async cancelReservation() {
			return { status: 'cancelled' as const }
		},
		async calculateCancellationPenalty() {
			return { penaltyMicros: 0n }
		},
		async receiveBookingWebhook() {
			return { ok: false, reason: 'not_used_in_factory', httpStatus: 400 }
		},
		...overrides,
	}
}

beforeEach(() => {
	__resetSequenceForTesting()
})
afterEach(() => {
	__resetSequenceForTesting()
})

describe('ETG factory — Round 8 P0-1 adapter wiring (ETG-F1..ETG-F5)', () => {
	it('[ETG-F1] booking.created.v1 → adapter.verifyBooking + createBooking invoked', async () => {
		const verifyMock = mock(async () => ({
			createBookingToken: 'tok-verify',
			checksum: 'sum',
			expiresAtUtc: new Date(Date.now() + 30_000).toISOString(),
			totalAmountMicros: 14_000_000n,
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime' as const,
				hoursBeforeRef: 72,
				penaltyKind: 'first_night' as const,
				penaltyValue: 1,
			},
		}))
		const createMock = mock(async () => ({ externalId: 'etg-ext-created-1' }))
		const adapter = buildAdapterMock({ verifyBooking: verifyMock, createBooking: createMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: 'booking-1',
			payload: {
				guestSnapshot: {
					email: 'real@yandex.ru',
					phone: '+79991234567',
					firstName: 'A',
					lastName: 'B',
				},
				propertyId: 'prop-1',
				roomTypeId: 'rt-1',
				ratePlanId: 'rp-1',
				checkIn: '2027-06-15',
				checkOut: '2027-06-17',
				guestCount: 2,
			},
		})
		expect(verifyMock).toHaveBeenCalledTimes(1)
		expect(createMock).toHaveBeenCalledTimes(1)
		expect(r).toEqual({
			ok: true,
			httpStatus: 200,
			responseBody: { externalId: 'etg-ext-created-1' },
		})
	})

	it('[ETG-F2] booking.cancelled.v1 → adapter.cancelReservation invoked с idempotencyKey', async () => {
		const cancelMock = mock(async () => ({ status: 'cancelled' as const }))
		const adapter = buildAdapterMock({ cancelReservation: cancelMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.cancelled.v1',
			idempotencyKey: 'cancel-1',
			payload: { externalId: 'etg-ext-to-cancel' },
		})
		expect(cancelMock).toHaveBeenCalledTimes(1)
		expect(cancelMock).toHaveBeenCalledWith({
			tenantId: 'org_etg',
			externalId: 'etg-ext-to-cancel',
			idempotencyKey: 'cancel-1',
		})
		expect(r).toEqual({ ok: true, httpStatus: 200, responseBody: { status: 'cancelled' } })
	})

	it('[ETG-F3] ari.delta.v1 → adapter.pushAri invoked с delta array', async () => {
		const pushMock = mock(
			async (): Promise<AriPushResult> => ({ accepted: 2, rejected: 0, errors: [] }),
		)
		const adapter = buildAdapterMock({ pushAri: pushMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const deltas: ReadonlyArray<AriDelta> = [
			{
				tenantId: 'org_etg',
				propertyId: 'prop-1',
				date: '2027-06-15',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				availability: 5,
				rateMicros: 7_000_000n,
				currency: 'RUB',
				sequenceNumber: 100n,
			},
			{
				tenantId: 'org_etg',
				propertyId: 'prop-1',
				date: '2027-06-16',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				availability: 4,
				rateMicros: 7_000_000n,
				currency: 'RUB',
				sequenceNumber: 101n,
			},
		]
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.ari.delta.v1',
			idempotencyKey: 'ari-1',
			payload: { deltas },
		})
		expect(pushMock).toHaveBeenCalledTimes(1)
		expect(r).toEqual({
			ok: true,
			httpStatus: 200,
			responseBody: { accepted: 2, rejected: 0 },
		})
	})

	it('[ETG-F4] inventory.adjusted.v1 → adapter.pushAri invoked', async () => {
		const pushMock = mock(
			async (): Promise<AriPushResult> => ({ accepted: 1, rejected: 0, errors: [] }),
		)
		const adapter = buildAdapterMock({ pushAri: pushMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const result = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.inventory.adjusted.v1',
			idempotencyKey: 'inv-1',
			payload: {
				deltas: [
					{
						tenantId: 'org_etg',
						propertyId: 'p1',
						date: '2027-06-15',
						roomTypeId: 'rt',
						ratePlanId: 'rp',
						availability: 3,
						rateMicros: 7_000_000n,
						currency: 'RUB',
						sequenceNumber: 1n,
					},
				],
			},
		})
		expect(pushMock).toHaveBeenCalledTimes(1)
		expect(result).toEqual({
			ok: true,
			httpStatus: 200,
			responseBody: { accepted: 1, rejected: 0 },
		})
	})

	it('[ETG-F5] rate.changed.v1 + restriction.changed.v1 also → pushAri', async () => {
		const pushMock = mock(
			async (): Promise<AriPushResult> => ({ accepted: 1, rejected: 0, errors: [] }),
		)
		const adapter = buildAdapterMock({ pushAri: pushMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const delta: AriDelta = {
			tenantId: 'org_etg',
			propertyId: 'p1',
			date: '2027-06-15',
			roomTypeId: 'rt',
			ratePlanId: 'rp',
			availability: 3,
			rateMicros: 7_000_000n,
			currency: 'RUB',
			sequenceNumber: 1n,
		}
		await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.rate.changed.v1',
			idempotencyKey: 'rate-1',
			payload: { deltas: [delta] },
		})
		await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.restriction.changed.v1',
			idempotencyKey: 'restr-1',
			payload: { deltas: [delta] },
		})
		expect(pushMock).toHaveBeenCalledTimes(2)
	})
})

describe('ETG factory — Round 8 P0-4 reserved-test-range shield (ETG-F6..ETG-F8)', () => {
	it('[ETG-F6] reserved-test domain email (example.com) → short-circuit, adapter NOT called', async () => {
		const verifyMock = mock(async () => ({
			createBookingToken: 'tok',
			checksum: 'sum',
			expiresAtUtc: new Date().toISOString(),
			totalAmountMicros: 1n,
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime' as const,
				hoursBeforeRef: 72,
				penaltyKind: 'first_night' as const,
				penaltyValue: 1,
			},
		}))
		const createMock = mock(async () => ({ externalId: 'should-not-reach' }))
		const adapter = buildAdapterMock({ verifyBooking: verifyMock, createBooking: createMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: 'reserved-1',
			payload: {
				guestSnapshot: {
					email: 'leak@example.com',
					phone: '+79991234567',
					firstName: 'X',
					lastName: 'Y',
				},
				propertyId: 'p',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				checkIn: '2027-06-15',
				checkOut: '2027-06-17',
				guestCount: 1,
			},
		})
		expect(verifyMock).toHaveBeenCalledTimes(0)
		expect(createMock).toHaveBeenCalledTimes(0)
		expect(r).toEqual({
			ok: true,
			httpStatus: 200,
			responseBody: 'reserved_test_range_shielded',
		})
	})

	it('[ETG-F7] reserved-test phone (+99899...) → short-circuit, adapter NOT called', async () => {
		const verifyMock = mock(async () => ({
			createBookingToken: 'tok',
			checksum: 'sum',
			expiresAtUtc: new Date().toISOString(),
			totalAmountMicros: 1n,
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime' as const,
				hoursBeforeRef: 72,
				penaltyKind: 'first_night' as const,
				penaltyValue: 1,
			},
		}))
		const createMock = mock(async () => ({ externalId: 'should-not-reach' }))
		const adapter = buildAdapterMock({ verifyBooking: verifyMock, createBooking: createMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: 'reserved-2',
			payload: {
				guestSnapshot: {
					email: 'good@yandex.ru',
					phone: '+99899123456789',
					firstName: 'X',
					lastName: 'Y',
				},
				propertyId: 'p',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				checkIn: '2027-06-15',
				checkOut: '2027-06-17',
				guestCount: 1,
			},
		})
		expect(verifyMock).toHaveBeenCalledTimes(0)
		expect(createMock).toHaveBeenCalledTimes(0)
		expect(r).toEqual({
			ok: true,
			httpStatus: 200,
			responseBody: 'reserved_test_range_shielded',
		})
	})

	it('[ETG-F8] real RU phone+domain → shield does NOT trigger, adapter IS called', async () => {
		const verifyMock = mock(async () => ({
			createBookingToken: 'tok',
			checksum: 'sum',
			expiresAtUtc: new Date().toISOString(),
			totalAmountMicros: 1n,
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime' as const,
				hoursBeforeRef: 72,
				penaltyKind: 'first_night' as const,
				penaltyValue: 1,
			},
		}))
		const createMock = mock(async () => ({ externalId: 'real-ext' }))
		const adapter = buildAdapterMock({ verifyBooking: verifyMock, createBooking: createMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: 'real-1',
			payload: {
				guestSnapshot: {
					email: 'guest@yandex.ru',
					phone: '+79991234567',
					firstName: 'A',
					lastName: 'B',
				},
				propertyId: 'p',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				checkIn: '2027-06-15',
				checkOut: '2027-06-17',
				guestCount: 1,
			},
		})
		expect(verifyMock).toHaveBeenCalledTimes(1)
		expect(createMock).toHaveBeenCalledTimes(1)
	})
})

describe('ETG factory — Round 8 error paths + sanitized logging (ETG-F9..ETG-F13)', () => {
	it('[ETG-F9] unknown eventType → 400 with errorMessage + errorCategory', async () => {
		const adapter = buildAdapterMock()
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = (await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.bogus.v9',
			idempotencyKey: 'bogus-1',
			payload: {},
		})) as {
			ok: boolean
			httpStatus: number | null
			errorMessage: string
			errorCategory: string
		}
		expect(r.ok).toBe(false)
		expect(r.httpStatus).toBe(400)
		expect(r.errorMessage).toBe('unknown_event_type: app.sochi.channel.bogus.v9')
		expect(r.errorCategory).toBe('invalid_payload')
	})

	it('[ETG-F10] adapter throws → returns ok:false with sanitized errorMessage (no raw PII)', async () => {
		const createMock = mock(async () => {
			throw new Error('upstream fail for guest=ivanov@yandex.ru phone=+79991234567')
		})
		const adapter = buildAdapterMock({ createBooking: createMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const result = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: 'err-1',
			payload: {
				guestSnapshot: {
					email: 'ivanov@yandex.ru',
					phone: '+79991234567',
					firstName: 'Иван',
					lastName: 'Иванов',
				},
				propertyId: 'p',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				checkIn: '2027-06-15',
				checkOut: '2027-06-17',
				guestCount: 1,
			},
		})
		const r = result as { ok: boolean; httpStatus: number | null; errorMessage?: string }
		expect(r.ok).toBe(false)
		// Sanitization: raw email/phone MUST be redacted in errorMessage
		expect(r.errorMessage).not.toContain('ivanov@yandex.ru')
		expect(r.errorMessage).not.toContain('+79991234567')
		expect(r.errorMessage).toContain('<email>')
		expect(r.errorMessage).toContain('<phone>')
	})

	it('[ETG-F11] adapter pushAri returns rejected>0 → handler reports rejected count + 422', async () => {
		const pushMock = mock(
			async (): Promise<AriPushResult> => ({
				accepted: 0,
				rejected: 1,
				errors: [{ category: 'invalid_payload', message: 'out_of_order_sequence' }],
			}),
		)
		const adapter = buildAdapterMock({ pushAri: pushMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.ari.delta.v1',
			idempotencyKey: 'ari-rej-1',
			payload: {
				deltas: [
					{
						tenantId: 'org_etg',
						propertyId: 'p',
						date: '2027-06-15',
						roomTypeId: 'rt',
						ratePlanId: 'rp',
						availability: 1,
						rateMicros: 1n,
						currency: 'RUB',
						sequenceNumber: 1n,
					},
				],
			},
		})
		const out = r as {
			ok: boolean
			httpStatus: number | null
			errorMessage?: string
			errorCategory?: string
		}
		expect(out.ok).toBe(false)
		expect(out.httpStatus).toBe(422)
		expect(out.errorMessage).toContain('invalid_payload')
		expect(out.errorCategory).toBe('invalid_payload')
	})

	it('[ETG-F12] booking.cancelled.v1 with missing externalId → ok:false 400 invalid_payload', async () => {
		const cancelMock = mock(async () => ({ status: 'cancelled' as const }))
		const adapter = buildAdapterMock({ cancelReservation: cancelMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.cancelled.v1',
			idempotencyKey: 'cancel-bad-1',
			payload: { /* externalId missing */ note: 'malformed' },
		})
		const out = r as { ok: boolean; httpStatus: number | null; errorMessage?: string }
		expect(out.ok).toBe(false)
		expect(out.httpStatus).toBe(400)
		expect(cancelMock).toHaveBeenCalledTimes(0)
	})

	it('[ETG-F13] booking.created.v1 with missing checkIn → ok:false 400 invalid_payload, adapter NOT called', async () => {
		const verifyMock = mock(async () => ({
			createBookingToken: 'tok',
			checksum: 'sum',
			expiresAtUtc: new Date().toISOString(),
			totalAmountMicros: 1n,
			cancellationPolicy: {
				referencePoint: 'GuestArrivalTime' as const,
				hoursBeforeRef: 72,
				penaltyKind: 'first_night' as const,
				penaltyValue: 1,
			},
		}))
		const adapter = buildAdapterMock({ verifyBooking: verifyMock })
		const { factory, captured } = buildFakeFactory(adapter)
		registerOstrovokEtgWithChannelFactory(factory)
		if (!captured.httpAttempt) throw new Error('handler not registered')
		const r = await captured.httpAttempt({
			tenantId: 'org_etg',
			eventType: 'app.sochi.channel.booking.created.v1',
			idempotencyKey: 'bad-1',
			payload: {
				guestSnapshot: {
					email: 'a@yandex.ru',
					phone: '+79991234567',
					firstName: 'A',
					lastName: 'B',
				},
				propertyId: 'p',
				roomTypeId: 'rt',
				ratePlanId: 'rp',
				// checkIn missing
				checkOut: '2027-06-17',
				guestCount: 1,
			},
		})
		const out = r as { ok: boolean; httpStatus: number | null; errorMessage?: string }
		expect(out.ok).toBe(false)
		expect(out.httpStatus).toBe(400)
		expect(verifyMock).toHaveBeenCalledTimes(0)
	})
})
