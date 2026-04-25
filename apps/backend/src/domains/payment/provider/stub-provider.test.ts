/**
 * StubPaymentProvider — strict unit tests.
 *
 * Invariants under test:
 *
 *   Capabilities:
 *     [SC1] code === 'stub'
 *     [SC2] capabilities.holdPeriodHours === 0 (synchronous)
 *     [SC3] capabilities.partialCapture === true
 *     [SC4] capabilities.fiscalization === 'none' (no native ОФД)
 *     [SC5] capabilities.supportsCorrection === false
 *
 *   initiate flow:
 *     [SI1] returns synchronous succeeded with authorized = captured = amount
 *     [SI2] confirmationUrl is null (no hosted checkout)
 *     [SI3] holdExpiresAt is null (no hold)
 *     [SI4] failureReason is null on success
 *     [SI5] generates a fresh providerPaymentId per call
 *     [SI6] idempotency: same providerIdempotencyKey → identical snapshot
 *     [SI7] different providerIdempotencyKey → different providerPaymentId
 *
 *   capture flow:
 *     [SCa1] full capture (amountMinor=null) returns authorized amount
 *     [SCa2] partial capture (amountMinor < authorized) returns capped amount
 *     [SCa3] capture > authorized throws RangeError
 *     [SCa4] capture against unknown providerPaymentId throws Error
 *     [SCa5] capture amount < 0 throws RangeError
 *
 *   cancel flow (post-capture polymorphic per T-Kassa pattern):
 *     [SCn1] cancel after capture returns RefundProviderSnapshot
 *     [SCn2] returned refund.amountMinor === captured amount
 *     [SCn3] cancel against unknown id throws
 *     [SCn4] idempotent cancel: second call returns same refundId
 *
 *   refund flow:
 *     [SR1] refund returns succeeded snapshot
 *     [SR2] idempotency: same providerIdempotencyKey → identical refund
 *     [SR3] negative amount throws RangeError
 *
 *   verifyWebhook flow:
 *     [SW1] valid signature + valid body → VerifiedWebhookEvent
 *     [SW2] missing signature throws
 *     [SW3] wrong signature value throws
 *     [SW4] non-JSON body throws
 *     [SW5] missing requestId throws
 *     [SW6] missing providerPaymentId throws
 *     [SW7] unknown providerPaymentId throws (defensive — provider would never)
 *     [SW8] dedupKey format is 'stub:<requestId>' (predictable for inbox dedup)
 *     [SW9] receivedAt uses injected `now`
 *
 *   releaseResidualHold:
 *     [SH1] no-op (stub auto-captures, ЮKassa parity)
 *
 * Style: deterministic — clock injected via `now`, delay set to 0 for tests.
 */
import { describe, expect, test } from 'vitest'
import { createStubPaymentProvider } from './stub-provider.ts'

const FROZEN = new Date('2026-04-25T12:00:00.000Z')
const fixed = () => FROZEN

function makeProvider() {
	return createStubPaymentProvider({ delayMs: 0, now: fixed })
}

/* ===================================================== capabilities */

describe('StubPaymentProvider — capabilities', () => {
	const p = makeProvider()
	test('[SC1] code === stub', () => {
		expect(p.code).toBe('stub')
	})
	test('[SC2] capabilities.holdPeriodHours === 0 (synchronous)', () => {
		expect(p.capabilities.holdPeriodHours).toBe(0)
	})
	test('[SC3] capabilities.partialCapture === true', () => {
		expect(p.capabilities.partialCapture).toBe(true)
	})
	test('[SC4] capabilities.fiscalization === none', () => {
		expect(p.capabilities.fiscalization).toBe('none')
	})
	test('[SC5] capabilities.supportsCorrection === false', () => {
		expect(p.capabilities.supportsCorrection).toBe(false)
	})
})

/* ============================================================= initiate */

describe('StubPaymentProvider — initiate', () => {
	test('[SI1] returns succeeded with authorized=captured=amount', async () => {
		const p = makeProvider()
		const snap = await p.initiate({
			localPaymentId: 'pay_local',
			method: 'stub',
			amountMinor: 1234n,
			currency: 'RUB',
			providerIdempotencyKey: 'k1',
		})
		expect(snap.status).toBe('succeeded')
		expect(snap.authorizedMinor).toBe(1234n)
		expect(snap.capturedMinor).toBe(1234n)
	})

	test('[SI2] confirmationUrl is null', async () => {
		const p = makeProvider()
		const snap = await p.initiate({
			localPaymentId: 'pay_local',
			method: 'stub',
			amountMinor: 100n,
			currency: 'RUB',
			providerIdempotencyKey: 'k2',
		})
		expect(snap.confirmationUrl).toBeNull()
	})

	test('[SI3] holdExpiresAt is null (synchronous)', async () => {
		const p = makeProvider()
		const snap = await p.initiate({
			localPaymentId: 'pay_local',
			method: 'stub',
			amountMinor: 100n,
			currency: 'RUB',
			providerIdempotencyKey: 'k3',
		})
		expect(snap.holdExpiresAt).toBeNull()
	})

	test('[SI4] failureReason is null on success', async () => {
		const p = makeProvider()
		const snap = await p.initiate({
			localPaymentId: 'pay_local',
			method: 'stub',
			amountMinor: 100n,
			currency: 'RUB',
			providerIdempotencyKey: 'k4',
		})
		expect(snap.failureReason).toBeNull()
	})

	test('[SI5] generates fresh providerPaymentId per call (different keys)', async () => {
		const p = makeProvider()
		const a = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 1n,
			currency: 'RUB',
			providerIdempotencyKey: 'k-a',
		})
		const b = await p.initiate({
			localPaymentId: 'p2',
			method: 'stub',
			amountMinor: 1n,
			currency: 'RUB',
			providerIdempotencyKey: 'k-b',
		})
		expect(a.providerPaymentId).not.toBe(b.providerPaymentId)
	})

	test('[SI6] idempotency: same key → identical snapshot (deep equal)', async () => {
		const p = makeProvider()
		const req = {
			localPaymentId: 'p1',
			method: 'stub' as const,
			amountMinor: 500n,
			currency: 'RUB',
			providerIdempotencyKey: 'replay-key',
		}
		const a = await p.initiate(req)
		const b = await p.initiate(req)
		expect(b).toEqual(a)
		expect(b.providerPaymentId).toBe(a.providerPaymentId)
	})

	test('[SI7] different keys → different providerPaymentIds (anti-collision)', async () => {
		const p = makeProvider()
		const ids = new Set<string>()
		for (let i = 0; i < 10; i++) {
			const snap = await p.initiate({
				localPaymentId: `p${i}`,
				method: 'stub',
				amountMinor: 1n,
				currency: 'RUB',
				providerIdempotencyKey: `k-${i}`,
			})
			ids.add(snap.providerPaymentId)
		}
		expect(ids.size).toBe(10) // All unique
	})
})

/* =============================================================== capture */

describe('StubPaymentProvider — capture', () => {
	async function setup() {
		const p = makeProvider()
		const initial = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 1000n,
			currency: 'RUB',
			providerIdempotencyKey: 'cap-k',
		})
		return { p, providerPaymentId: initial.providerPaymentId }
	}

	test('[SCa1] full capture (null) returns authorized amount', async () => {
		const { p, providerPaymentId } = await setup()
		const snap = await p.capture(providerPaymentId, null)
		expect(snap.capturedMinor).toBe(1000n)
		expect(snap.status).toBe('succeeded')
	})

	test('[SCa2] partial capture returns clamped amount', async () => {
		const { p, providerPaymentId } = await setup()
		const snap = await p.capture(providerPaymentId, 600n)
		expect(snap.capturedMinor).toBe(600n)
		expect(snap.status).toBe('succeeded')
	})

	test('[SCa3] capture > authorized throws RangeError', async () => {
		const { p, providerPaymentId } = await setup()
		await expect(p.capture(providerPaymentId, 1500n)).rejects.toThrow(
			/Stub capture 1500 exceeds authorized 1000/,
		)
	})

	test('[SCa4] capture against unknown id throws', async () => {
		const p = makeProvider()
		await expect(p.capture('pay_unknown_xxx', 100n)).rejects.toThrow(
			/unknown providerPaymentId pay_unknown_xxx/,
		)
	})

	test('[SCa5] capture amount < 0 throws RangeError', async () => {
		const { p, providerPaymentId } = await setup()
		await expect(p.capture(providerPaymentId, -1n)).rejects.toThrow(
			/Stub capture amount must be >= 0/,
		)
	})
})

/* ================================================================ cancel */

describe('StubPaymentProvider — cancel (polymorphic post-capture refund)', () => {
	test('[SCn1+SCn2] cancel after auto-capture returns RefundProviderSnapshot with full amount', async () => {
		const p = makeProvider()
		const initial = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 700n,
			currency: 'RUB',
			providerIdempotencyKey: 'cancel-k',
		})
		const result = await p.cancel(initial.providerPaymentId)
		// Distinguish via providerRefundId presence (interface contract)
		expect('providerRefundId' in result).toBe(true)
		if ('providerRefundId' in result) {
			expect(result.amountMinor).toBe(700n)
			expect(result.status).toBe('succeeded')
			expect(result.failureReason).toBeNull()
		}
	})

	test('[SCn3] cancel against unknown id throws', async () => {
		const p = makeProvider()
		await expect(p.cancel('pay_no_such_xxx')).rejects.toThrow(
			/unknown providerPaymentId pay_no_such_xxx/,
		)
	})

	test('[SCn4] idempotent: second cancel returns same refundId', async () => {
		const p = makeProvider()
		const initial = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 100n,
			currency: 'RUB',
			providerIdempotencyKey: 'cancel-replay',
		})
		const a = await p.cancel(initial.providerPaymentId)
		const b = await p.cancel(initial.providerPaymentId)
		expect(b).toEqual(a)
	})
})

/* ================================================================ refund */

describe('StubPaymentProvider — refund', () => {
	test('[SR1] refund returns succeeded snapshot', async () => {
		const p = makeProvider()
		const initial = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 500n,
			currency: 'RUB',
			providerIdempotencyKey: 'refund-init',
		})
		const refund = await p.refund({
			providerPaymentId: initial.providerPaymentId,
			amountMinor: 200n,
			providerIdempotencyKey: 'refund-k1',
			reason: 'guest dispute',
		})
		expect(refund.status).toBe('succeeded')
		expect(refund.amountMinor).toBe(200n)
		expect(refund.failureReason).toBeNull()
	})

	test('[SR2] idempotency: same key → identical refund', async () => {
		const p = makeProvider()
		const initial = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 500n,
			currency: 'RUB',
			providerIdempotencyKey: 'refund-init-2',
		})
		const req = {
			providerPaymentId: initial.providerPaymentId,
			amountMinor: 100n,
			providerIdempotencyKey: 'refund-replay',
			reason: 'replay test',
		}
		const a = await p.refund(req)
		const b = await p.refund(req)
		expect(b).toEqual(a)
	})

	test('[SR3] negative amount throws RangeError', async () => {
		const p = makeProvider()
		await expect(
			p.refund({
				providerPaymentId: 'pay_x',
				amountMinor: -1n,
				providerIdempotencyKey: 'neg-k',
				reason: 'should fail',
			}),
		).rejects.toThrow(/Stub refund amount must be >= 0/)
	})
})

/* ===================================================== verifyWebhook */

function makeBody(body: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(body))
}

function headersWith(sig: string | null): Headers {
	const h = new Headers()
	if (sig !== null) h.set('x-stub-signature', sig)
	return h
}

describe('StubPaymentProvider — verifyWebhook', () => {
	async function seedPayment() {
		const p = makeProvider()
		const initial = await p.initiate({
			localPaymentId: 'p1',
			method: 'stub',
			amountMinor: 1000n,
			currency: 'RUB',
			providerIdempotencyKey: 'wh-init',
		})
		return { p, providerPaymentId: initial.providerPaymentId }
	}

	test('[SW1] valid signature + body → VerifiedWebhookEvent', async () => {
		const { p, providerPaymentId } = await seedPayment()
		const event = await p.verifyWebhook(
			headersWith('stub-ok'),
			makeBody({ requestId: 'req_xxx', providerPaymentId }),
		)
		expect(event.providerCode).toBe('stub')
		expect(event.dedupKey).toBe('stub:req_xxx')
		expect(event.subject.kind).toBe('payment')
	})

	test('[SW2] missing signature throws', async () => {
		const p = makeProvider()
		await expect(p.verifyWebhook(headersWith(null), makeBody({ requestId: 'r' }))).rejects.toThrow(
			/signature mismatch/,
		)
	})

	test('[SW3] wrong signature value throws', async () => {
		const p = makeProvider()
		await expect(
			p.verifyWebhook(headersWith('not-stub-ok'), makeBody({ requestId: 'r' })),
		).rejects.toThrow(/signature mismatch/)
	})

	test('[SW4] non-JSON body throws', async () => {
		const p = makeProvider()
		await expect(
			p.verifyWebhook(headersWith('stub-ok'), new TextEncoder().encode('not json {')),
		).rejects.toThrow(/not valid JSON/)
	})

	test('[SW5] missing requestId throws', async () => {
		const p = makeProvider()
		await expect(
			p.verifyWebhook(headersWith('stub-ok'), makeBody({ providerPaymentId: 'p' })),
		).rejects.toThrow(/must include a string 'requestId'/)
	})

	test('[SW6] missing providerPaymentId throws', async () => {
		const p = makeProvider()
		await expect(
			p.verifyWebhook(headersWith('stub-ok'), makeBody({ requestId: 'r' })),
		).rejects.toThrow(/must include 'providerPaymentId'/)
	})

	test('[SW7] unknown providerPaymentId throws', async () => {
		const p = makeProvider()
		await expect(
			p.verifyWebhook(
				headersWith('stub-ok'),
				makeBody({ requestId: 'r', providerPaymentId: 'pay_unknown_xxx' }),
			),
		).rejects.toThrow(/unknown providerPaymentId pay_unknown_xxx/)
	})

	test('[SW8+SW9] dedupKey format + receivedAt uses injected clock', async () => {
		const { p, providerPaymentId } = await seedPayment()
		const event = await p.verifyWebhook(
			headersWith('stub-ok'),
			makeBody({ requestId: 'unique-id-42', providerPaymentId }),
		)
		expect(event.dedupKey).toBe('stub:unique-id-42')
		// Frozen clock = exact assertion
		expect(event.receivedAt).toBe(FROZEN.toISOString())
	})
})

/* =================================================== releaseResidualHold */

describe('StubPaymentProvider — releaseResidualHold', () => {
	test('[SH1] no-op (resolves without error)', async () => {
		const p = makeProvider()
		await expect(p.releaseResidualHold('any_id_works')).resolves.toBeUndefined()
	})
})
