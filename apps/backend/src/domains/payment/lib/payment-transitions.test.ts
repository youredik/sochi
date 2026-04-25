/**
 * Strict tests for payment-transitions.ts pure FSM.
 *
 * Invariants under test (cross-referenced to canon `project_payment_domain_canonical.md`):
 *
 *   isTerminal:
 *     [TR1] All 4 terminal states return true: refunded/canceled/failed/expired
 *     [TR2] All 5 non-terminal return false: created/pending/waiting_for_capture/
 *           succeeded/partially_refunded
 *     [TR3] Property: ∀ status, isTerminal(s) ⇔ allowedTransitions(s) is empty
 *
 *   isPostCapture / canRefund:
 *     [PC1] succeeded/partially_refunded/refunded → isPostCapture=true
 *     [PC2] All other states → isPostCapture=false
 *     [PC3] canRefund only on succeeded + partially_refunded (NOT refunded)
 *
 *   canTransition (full transition matrix exercised):
 *     [CT1] created→pending allowed; created→other forbidden
 *     [CT2] pending→{waiting_for_capture, succeeded, failed} allowed; rest forbidden
 *     [CT3] waiting_for_capture→{succeeded, canceled, expired} allowed; rest forbidden
 *     [CT4] succeeded→{partially_refunded, refunded} allowed; rest forbidden
 *     [CT5] partially_refunded→refunded allowed; rest forbidden
 *     [CT6] All terminal states → no outgoing edges (canon #2 terminal-immutability)
 *
 *   canTransitionForProvider (canon #17 sbp-no-preauth):
 *     [SP1] sbp: pending→waiting_for_capture FORBIDDEN
 *     [SP2] sbp: pending→succeeded ALLOWED (autocapture path)
 *     [SP3] yookassa: pending→waiting_for_capture ALLOWED (preauth path)
 *     [SP4] tkassa: pending→waiting_for_capture ALLOWED
 *     [SP5] stub: pending→succeeded ALLOWED
 *     [SP6] sbp: any other transition behaves like canTransition
 *
 *   holdPeriodHours / computeHoldExpiresAt / isHoldExpired:
 *     [HP1] yookassa = 72h, tkassa = 168h, sbp/stub/digital_ruble = 0
 *     [HP2] computeHoldExpiresAt for synchronous providers returns null
 *     [HP3] computeHoldExpiresAt(yookassa, t) === t + 72h exactly
 *     [HP4] computeHoldExpiresAt(tkassa, t) === t + 168h exactly
 *     [HP5] isHoldExpired with null → false (synchronous never expires)
 *     [HP6] isHoldExpired at exact boundary (now === expiry) → true (>=)
 *     [HP7] isHoldExpired before boundary → false
 *     [HP8] Property: holdPeriodHours always non-negative
 *
 *   deriveRefundStatus (canon #23 partial-refund-derived-flag):
 *     [DR1] refundedMinor=0 → succeeded
 *     [DR2] refundedMinor=captured → refunded
 *     [DR3] 0 < refundedMinor < captured → partially_refunded
 *     [DR4] refundedMinor > captured → RangeError (canon #1 cap)
 *     [DR5] negative captured/refunded → RangeError
 *     [DR6] Property: ∀ valid (cap, ref), refundedMinor=cap ⇔ refunded
 *
 *   assertTransition / assertTransitionForProvider:
 *     [AT1] Allowed transition: no throw
 *     [AT2] Forbidden transition: throws Error with both endpoints in message
 *     [AT3] sbp pending→waiting_for_capture throws (per #17)
 *
 *   captureExcess / exceedsAuthorized (canon #10 capture-amount-bound):
 *     [CE1] capturedMinor < authorizedMinor → captureExcess negative
 *     [CE2] capturedMinor === authorizedMinor → captureExcess zero
 *     [CE3] capturedMinor > authorizedMinor → captureExcess positive
 *     [CE4] exceedsAuthorized with sum < authorized → false
 *     [CE5] exceedsAuthorized with sum === authorized → false (boundary)
 *     [CE6] exceedsAuthorized with sum > authorized → true
 *     [CE7] negative inputs to exceedsAuthorized throw
 *     [CE8] Property: ∀ valid amounts, exceedsAuthorized iff sum > authorized
 *
 * Style: exact-value asserts; per-status enumeration (not just representative);
 * fast-check property tests using integer-over-epoch (gotcha-safe).
 */
import { fc, test } from '@fast-check/vitest'
import type { PaymentProviderCode, PaymentStatus } from '@horeca/shared'
import { describe, expect, test as vitestTest } from 'vitest'
import {
	assertTransition,
	assertTransitionForProvider,
	canRefund,
	canTransition,
	canTransitionForProvider,
	captureExcess,
	computeHoldExpiresAt,
	deriveRefundStatus,
	exceedsAuthorized,
	holdPeriodHours,
	isHoldExpired,
	isPostCapture,
	isTerminal,
} from './payment-transitions.ts'

const ALL_STATUSES: readonly PaymentStatus[] = [
	'created',
	'pending',
	'waiting_for_capture',
	'succeeded',
	'partially_refunded',
	'refunded',
	'canceled',
	'failed',
	'expired',
] as const

const TERMINAL: readonly PaymentStatus[] = ['refunded', 'canceled', 'failed', 'expired'] as const

const ALL_PROVIDERS: readonly PaymentProviderCode[] = [
	'stub',
	'yookassa',
	'tkassa',
	'sbp',
	'digital_ruble',
] as const

const statusArb = fc.constantFrom<PaymentStatus>(...ALL_STATUSES)

/* ================================================================== isTerminal */

describe('isTerminal — exhaustive enum', () => {
	vitestTest('[TR1] all 4 terminal states return true', () => {
		expect(isTerminal('refunded')).toBe(true)
		expect(isTerminal('canceled')).toBe(true)
		expect(isTerminal('failed')).toBe(true)
		expect(isTerminal('expired')).toBe(true)
	})

	vitestTest('[TR2] all 5 non-terminal states return false', () => {
		expect(isTerminal('created')).toBe(false)
		expect(isTerminal('pending')).toBe(false)
		expect(isTerminal('waiting_for_capture')).toBe(false)
		expect(isTerminal('succeeded')).toBe(false)
		expect(isTerminal('partially_refunded')).toBe(false)
	})

	test.prop([statusArb])('[TR3] terminal iff no outgoing edges', (status) => {
		const hasOutgoing = ALL_STATUSES.some(
			(other) => other !== status && canTransition(status, other),
		)
		expect(isTerminal(status)).toBe(!hasOutgoing)
	})
})

/* ============================================== isPostCapture / canRefund */

describe('isPostCapture / canRefund — refund eligibility gates', () => {
	vitestTest('[PC1] succeeded/partially_refunded/refunded → post-capture', () => {
		expect(isPostCapture('succeeded')).toBe(true)
		expect(isPostCapture('partially_refunded')).toBe(true)
		expect(isPostCapture('refunded')).toBe(true)
	})

	vitestTest('[PC2] all other states → not post-capture', () => {
		const nonPost: PaymentStatus[] = [
			'created',
			'pending',
			'waiting_for_capture',
			'canceled',
			'failed',
			'expired',
		]
		for (const s of nonPost) {
			expect(isPostCapture(s)).toBe(false)
		}
	})

	vitestTest('[PC3] canRefund: only succeeded + partially_refunded (NOT refunded)', () => {
		expect(canRefund('succeeded')).toBe(true)
		expect(canRefund('partially_refunded')).toBe(true)
		// refunded is post-capture but cumulatively full → NO new refunds (canon #1)
		expect(canRefund('refunded')).toBe(false)
		// All other states
		const nonRefundable: PaymentStatus[] = [
			'created',
			'pending',
			'waiting_for_capture',
			'canceled',
			'failed',
			'expired',
		]
		for (const s of nonRefundable) {
			expect(canRefund(s)).toBe(false)
		}
	})
})

/* ============================================================ canTransition */

describe('canTransition — full transition matrix exhaustive', () => {
	vitestTest('[CT1] created → pending only', () => {
		for (const to of ALL_STATUSES) {
			expect(canTransition('created', to)).toBe(to === 'pending')
		}
	})

	vitestTest('[CT2] pending → {waiting_for_capture, succeeded, failed}', () => {
		const allowed = new Set<PaymentStatus>(['waiting_for_capture', 'succeeded', 'failed'])
		for (const to of ALL_STATUSES) {
			expect(canTransition('pending', to)).toBe(allowed.has(to))
		}
	})

	vitestTest('[CT3] waiting_for_capture → {succeeded, canceled, expired}', () => {
		const allowed = new Set<PaymentStatus>(['succeeded', 'canceled', 'expired'])
		for (const to of ALL_STATUSES) {
			expect(canTransition('waiting_for_capture', to)).toBe(allowed.has(to))
		}
	})

	vitestTest('[CT4] succeeded → {partially_refunded, refunded}', () => {
		const allowed = new Set<PaymentStatus>(['partially_refunded', 'refunded'])
		for (const to of ALL_STATUSES) {
			expect(canTransition('succeeded', to)).toBe(allowed.has(to))
		}
	})

	vitestTest('[CT5] partially_refunded → refunded only', () => {
		for (const to of ALL_STATUSES) {
			expect(canTransition('partially_refunded', to)).toBe(to === 'refunded')
		}
	})

	vitestTest('[CT6] all 4 terminal states have NO outgoing edges (canon #2)', () => {
		for (const from of TERMINAL) {
			for (const to of ALL_STATUSES) {
				expect(canTransition(from, to)).toBe(false)
			}
		}
	})
})

/* =========================================================== per-provider gate */

describe('canTransitionForProvider — sbp-no-preauth (canon #17)', () => {
	vitestTest('[SP1] sbp: pending → waiting_for_capture FORBIDDEN', () => {
		expect(canTransitionForProvider('sbp', 'pending', 'waiting_for_capture')).toBe(false)
	})

	vitestTest('[SP2] sbp: pending → succeeded ALLOWED (autocapture)', () => {
		expect(canTransitionForProvider('sbp', 'pending', 'succeeded')).toBe(true)
	})

	vitestTest('[SP3] yookassa: pending → waiting_for_capture ALLOWED (preauth path)', () => {
		expect(canTransitionForProvider('yookassa', 'pending', 'waiting_for_capture')).toBe(true)
	})

	vitestTest('[SP4] tkassa: pending → waiting_for_capture ALLOWED', () => {
		expect(canTransitionForProvider('tkassa', 'pending', 'waiting_for_capture')).toBe(true)
	})

	vitestTest('[SP5] stub: pending → succeeded ALLOWED (synchronous)', () => {
		expect(canTransitionForProvider('stub', 'pending', 'succeeded')).toBe(true)
	})

	vitestTest('[SP6] sbp passes-through canTransition for non-preauth edges', () => {
		// All other edges behave like canTransition
		for (const from of ALL_STATUSES) {
			for (const to of ALL_STATUSES) {
				if (from === 'pending' && to === 'waiting_for_capture') continue
				expect(canTransitionForProvider('sbp', from, to)).toBe(canTransition(from, to))
			}
		}
	})
})

/* =========================================================== holdPeriodHours */

describe('holdPeriodHours / computeHoldExpiresAt / isHoldExpired', () => {
	vitestTest('[HP1] exact provider hold lifetimes', () => {
		expect(holdPeriodHours('yookassa')).toBe(72)
		expect(holdPeriodHours('tkassa')).toBe(168)
		expect(holdPeriodHours('sbp')).toBe(0)
		expect(holdPeriodHours('stub')).toBe(0)
		expect(holdPeriodHours('digital_ruble')).toBe(0)
	})

	vitestTest('[HP2] computeHoldExpiresAt returns null for synchronous providers', () => {
		const t0 = new Date('2026-04-25T12:00:00.000Z')
		expect(computeHoldExpiresAt('sbp', t0)).toBeNull()
		expect(computeHoldExpiresAt('stub', t0)).toBeNull()
		expect(computeHoldExpiresAt('digital_ruble', t0)).toBeNull()
	})

	vitestTest('[HP3] computeHoldExpiresAt(yookassa, t) = t + 72h exactly', () => {
		const t0 = new Date('2026-04-25T12:00:00.000Z')
		const expiry = computeHoldExpiresAt('yookassa', t0)
		expect(expiry).not.toBeNull()
		expect(expiry?.toISOString()).toBe('2026-04-28T12:00:00.000Z')
	})

	vitestTest('[HP4] computeHoldExpiresAt(tkassa, t) = t + 168h (7 days) exactly', () => {
		const t0 = new Date('2026-04-25T12:00:00.000Z')
		const expiry = computeHoldExpiresAt('tkassa', t0)
		expect(expiry).not.toBeNull()
		expect(expiry?.toISOString()).toBe('2026-05-02T12:00:00.000Z')
	})

	vitestTest('[HP5] isHoldExpired with null → false (synchronous never expires)', () => {
		expect(isHoldExpired(null, new Date())).toBe(false)
	})

	vitestTest('[HP6] isHoldExpired at exact boundary → true (now >= expiry)', () => {
		const t = new Date('2026-04-28T12:00:00.000Z')
		expect(isHoldExpired(t, t)).toBe(true)
	})

	vitestTest('[HP7] isHoldExpired strictly before boundary → false', () => {
		const expiry = new Date('2026-04-28T12:00:00.000Z')
		const before = new Date('2026-04-28T11:59:59.999Z')
		expect(isHoldExpired(expiry, before)).toBe(false)
	})

	const providerArb = fc.constantFrom<PaymentProviderCode>(...ALL_PROVIDERS)

	test.prop([providerArb])('[HP8] holdPeriodHours always non-negative integer', (p) => {
		const h = holdPeriodHours(p)
		expect(Number.isInteger(h)).toBe(true)
		expect(h).toBeGreaterThanOrEqual(0)
	})
})

/* ============================================================ deriveRefundStatus */

describe('deriveRefundStatus — refund-projection (canon #23)', () => {
	vitestTest('[DR1] refundedMinor=0 → succeeded', () => {
		expect(deriveRefundStatus(1000n, 0n)).toBe('succeeded')
	})

	vitestTest('[DR2] refundedMinor=captured → refunded', () => {
		expect(deriveRefundStatus(1000n, 1000n)).toBe('refunded')
	})

	vitestTest('[DR3] 0 < refundedMinor < captured → partially_refunded', () => {
		expect(deriveRefundStatus(1000n, 1n)).toBe('partially_refunded')
		expect(deriveRefundStatus(1000n, 500n)).toBe('partially_refunded')
		expect(deriveRefundStatus(1000n, 999n)).toBe('partially_refunded')
	})

	vitestTest('[DR4] refundedMinor > captured throws RangeError (canon #1 cap)', () => {
		expect(() => deriveRefundStatus(1000n, 1001n)).toThrow(
			/refundedMinor \(1001\) must be <= capturedMinor \(1000\)/,
		)
	})

	vitestTest('[DR5] negative inputs throw RangeError', () => {
		expect(() => deriveRefundStatus(-1n, 0n)).toThrow(/capturedMinor must be >= 0/)
		expect(() => deriveRefundStatus(100n, -1n)).toThrow(/refundedMinor must be >= 0/)
	})

	vitestTest(
		'[DR5b] zero captured + zero refunded → succeeded (boundary distinguishes < from <=)',
		() => {
			// Validates that the guard is `< 0n`, not `<= 0n`. With <=, captured=0
			// would erroneously throw. Zero captured is a legitimate state for a
			// payment that never reached `succeeded` (e.g. canceled before capture)
			// — caller should still be able to ask for derivation, getting 'succeeded'
			// trivially since refunded=0.
			expect(deriveRefundStatus(0n, 0n)).toBe('succeeded')
		},
	)

	const refundArb = fc
		.tuple(fc.bigInt({ min: 0n, max: 1_000_000_000n }), fc.bigInt({ min: 0n, max: 1_000_000_000n }))
		.filter(([cap, ref]) => ref <= cap)

	test.prop([refundArb])('[DR6] result classification is exhaustive', ([cap, ref]) => {
		const status = deriveRefundStatus(cap, ref)
		if (ref === 0n) expect(status).toBe('succeeded')
		else if (ref === cap) expect(status).toBe('refunded')
		else expect(status).toBe('partially_refunded')
	})
})

/* ================================================================ assertions */

describe('assertTransition / assertTransitionForProvider', () => {
	vitestTest('[AT1] allowed transition does not throw', () => {
		expect(() => assertTransition('created', 'pending')).not.toThrow()
		expect(() => assertTransition('pending', 'succeeded')).not.toThrow()
		expect(() => assertTransition('partially_refunded', 'refunded')).not.toThrow()
	})

	vitestTest('[AT2] forbidden transition throws Error with both endpoints', () => {
		expect(() => assertTransition('created', 'succeeded')).toThrow(
			/Forbidden Payment SM transition: 'created' → 'succeeded'/,
		)
		expect(() => assertTransition('refunded', 'succeeded')).toThrow(
			/Forbidden Payment SM transition: 'refunded' → 'succeeded'/,
		)
	})

	vitestTest('[AT3] sbp pending → waiting_for_capture throws (canon #17)', () => {
		expect(() => assertTransitionForProvider('sbp', 'pending', 'waiting_for_capture')).toThrow(
			/Forbidden Payment SM transition for provider 'sbp'.*'pending' → 'waiting_for_capture'/,
		)
	})

	vitestTest('[AT3b] same edge allowed for non-sbp providers', () => {
		expect(() =>
			assertTransitionForProvider('yookassa', 'pending', 'waiting_for_capture'),
		).not.toThrow()
		expect(() =>
			assertTransitionForProvider('tkassa', 'pending', 'waiting_for_capture'),
		).not.toThrow()
	})
})

/* ====================================================== captureExcess / exceeds */

describe('captureExcess / exceedsAuthorized — canon #10 capture-amount-bound', () => {
	vitestTest('[CE1] capturedMinor < authorizedMinor → captureExcess negative', () => {
		expect(captureExcess(700n, 1000n)).toBe(-300n)
	})

	vitestTest('[CE2] capturedMinor === authorizedMinor → captureExcess zero', () => {
		expect(captureExcess(1000n, 1000n)).toBe(0n)
	})

	vitestTest('[CE3] capturedMinor > authorizedMinor → captureExcess positive', () => {
		expect(captureExcess(1500n, 1000n)).toBe(500n)
	})

	vitestTest('[CE4] exceedsAuthorized: sum < authorized → false', () => {
		expect(exceedsAuthorized(300n, 200n, 1000n)).toBe(false)
	})

	vitestTest('[CE5] exceedsAuthorized: sum === authorized → false (boundary)', () => {
		expect(exceedsAuthorized(700n, 300n, 1000n)).toBe(false)
	})

	vitestTest('[CE6] exceedsAuthorized: sum > authorized → true', () => {
		expect(exceedsAuthorized(700n, 301n, 1000n)).toBe(true)
		expect(exceedsAuthorized(0n, 1001n, 1000n)).toBe(true)
	})

	vitestTest('[CE7] negative inputs to exceedsAuthorized throw RangeError', () => {
		expect(() => exceedsAuthorized(-1n, 100n, 1000n)).toThrow(/All amounts must be >= 0/)
		expect(() => exceedsAuthorized(100n, -1n, 1000n)).toThrow(/All amounts must be >= 0/)
		expect(() => exceedsAuthorized(100n, 100n, -1n)).toThrow(/All amounts must be >= 0/)
	})

	vitestTest('[CE7b] zero amounts allowed (boundary distinguishes < from <=)', () => {
		// The < 0n guards must NOT trip on zero. Zero request is a legitimate
		// no-op capture check, zero authorized means "no authorization yet"
		// (used in pending state pre-condition checks).
		expect(exceedsAuthorized(0n, 0n, 0n)).toBe(false)
		expect(exceedsAuthorized(0n, 0n, 1000n)).toBe(false)
		expect(exceedsAuthorized(500n, 0n, 1000n)).toBe(false)
		expect(exceedsAuthorized(0n, 1000n, 1000n)).toBe(false)
	})

	const tripletArb = fc.tuple(
		fc.bigInt({ min: 0n, max: 1_000_000n }),
		fc.bigInt({ min: 0n, max: 1_000_000n }),
		fc.bigInt({ min: 0n, max: 2_000_000n }),
	)

	test.prop([tripletArb])(
		'[CE8] exceedsAuthorized iff captured + request > authorized',
		([captured, request, authorized]) => {
			const sum = captured + request
			expect(exceedsAuthorized(captured, request, authorized)).toBe(sum > authorized)
		},
	)
})
