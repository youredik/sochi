/**
 * Strict tests for refund-math.ts pure money math.
 *
 * Pre-done audit checklist applied FROM START (per `feedback_pre_done_audit.md`):
 *
 *   sumSucceededMinor / sumActiveMinor:
 *     [SM1] empty array → 0
 *     [SM2] only succeeded counted in sumSucceededMinor (pending + failed excluded)
 *     [SM3] succeeded + pending counted in sumActiveMinor (failed excluded)
 *     [SM4] property: sumActive >= sumSucceeded for any refund list
 *     [SM5] order independence (commutative)
 *
 *   assertRefundCap (canon #1 — most critical):
 *     [RC1] currentSum + newAmount === captured → no throw (boundary)
 *     [RC2] currentSum + newAmount < captured → no throw
 *     [RC3] currentSum + newAmount > captured → RangeError
 *     [RC4] negative captured → RangeError
 *     [RC5] negative currentSum → RangeError
 *     [RC6] zero/negative newAmount → RangeError (must be > 0)
 *     [RC7] property: ∀ valid (cap, sum, new) — throws iff sum+new > cap
 *
 *   refundHeadroomMinor:
 *     [HR1] captured > sum → captured - sum
 *     [HR2] captured === sum → 0 (no headroom)
 *     [HR3] captured < sum → 0 (clamped, no negative headroom)
 *     [HR4] negative captured/sum throws
 *
 *   hasActiveCausality:
 *     [HC1] empty list → false
 *     [HC2] matching succeeded refund → true
 *     [HC3] matching pending refund → true
 *     [HC4] matching failed refund → false (failed allows retry)
 *     [HC5] non-matching refunds → false
 *     [HC6] all 3 causality kinds: userInitiated/dispute/tkassa_cancel
 *
 *   isTerminalRefund:
 *     [TR1] succeeded → true
 *     [TR2] failed → true
 *     [TR3] pending → false
 *
 *   canTransitionRefund:
 *     [CT1] pending → succeeded allowed
 *     [CT2] pending → failed allowed
 *     [CT3] pending → pending forbidden (no self-loop)
 *     [CT4] succeeded → any forbidden (terminal)
 *     [CT5] failed → any forbidden (terminal)
 *
 *   assertTransitionRefund:
 *     [AT1] allowed transition no throw
 *     [AT2] forbidden transition throws with both endpoints in message
 */
import * as fc from 'fast-check'
import type { Refund, RefundStatus } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import {
	assertRefundCap,
	assertTransitionRefund,
	canTransitionRefund,
	hasActiveCausality,
	isTerminalRefund,
	refundHeadroomMinor,
	sumActiveMinor,
	sumSucceededMinor,
} from './refund-math.ts'

const ALL_STATUSES: readonly RefundStatus[] = ['pending', 'succeeded', 'failed'] as const

/* =================================================== sumSucceededMinor + sumActiveMinor */

describe('sumSucceededMinor / sumActiveMinor', () => {
	test('[SM1] empty array → 0', () => {
		expect(sumSucceededMinor([])).toBe(0n)
		expect(sumActiveMinor([])).toBe(0n)
	})

	test('[SM2] sumSucceededMinor: only succeeded counted', () => {
		const refunds = [
			{ amountMinor: '100', status: 'succeeded' as const },
			{ amountMinor: '200', status: 'succeeded' as const },
			{ amountMinor: '999', status: 'pending' as const },
			{ amountMinor: '888', status: 'failed' as const },
		]
		expect(sumSucceededMinor(refunds)).toBe(300n)
	})

	test('[SM3] sumActiveMinor: succeeded + pending counted, failed excluded', () => {
		const refunds = [
			{ amountMinor: '100', status: 'succeeded' as const },
			{ amountMinor: '200', status: 'pending' as const },
			{ amountMinor: '999', status: 'failed' as const },
		]
		expect(sumActiveMinor(refunds)).toBe(300n)
	})

	const refundArb = fc.record({
		amountMinor: fc.bigInt({ min: 0n, max: 1_000_000n }).map((n) => n.toString()),
		status: fc.constantFrom<RefundStatus>(...ALL_STATUSES),
	})

	test('[SM4] property: sumActive >= sumSucceeded', () => {
		void fc.assert(
			fc.property(fc.array(refundArb, { maxLength: 30 }), (refunds) => {
				expect(sumActiveMinor(refunds)).toBeGreaterThanOrEqual(sumSucceededMinor(refunds))
			}),
		)
	})

	test('[SM5] order-independent (commutative)', () => {
		void fc.assert(
			fc.property(fc.array(refundArb, { maxLength: 20 }), (refunds) => {
				const reversed = [...refunds].reverse()
				expect(sumSucceededMinor(refunds)).toBe(sumSucceededMinor(reversed))
				expect(sumActiveMinor(refunds)).toBe(sumActiveMinor(reversed))
			}),
		)
	})
})

/* =========================================================== assertRefundCap (canon #1) */

describe('assertRefundCap — canon invariant #1 (most critical money check)', () => {
	test('[RC1] currentSum + newAmount === captured → no throw (boundary)', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 500n, newAmountMinor: 500n }),
		).not.toThrow()
	})

	test('[RC2] currentSum + newAmount < captured → no throw', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 200n, newAmountMinor: 300n }),
		).not.toThrow()
	})

	test('[RC3] currentSum + newAmount > captured → RangeError', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 700n, newAmountMinor: 301n }),
		).toThrow(/Refund cap exceeded: 700 \+ 301 > 1000/)
	})

	test('[RC3b] currentSum already at cap, any new amount → throws', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 1000n, newAmountMinor: 1n }),
		).toThrow(/Refund cap exceeded/)
	})

	test('[RC4] negative captured → RangeError', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: -1n, currentSumMinor: 0n, newAmountMinor: 100n }),
		).toThrow(/capturedMinor must be >= 0, got -1/)
	})

	test('[RC5] negative currentSum → RangeError', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: -1n, newAmountMinor: 100n }),
		).toThrow(/currentSumMinor must be >= 0, got -1/)
	})

	test('[RC6] zero or negative newAmount → RangeError (must be > 0, canon #20)', () => {
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 0n, newAmountMinor: 0n }),
		).toThrow(/newAmountMinor must be > 0, got 0/)
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 0n, newAmountMinor: -1n }),
		).toThrow(/newAmountMinor must be > 0, got -1/)
	})

	// Stryker 2026-05-13: kill `< 0n` ↔ `<= 0n` boundary mutants on lines 98/101.
	// Zero IS a valid value (uncaptured payment can have capturedMinor=0n) — the
	// guard rejects negatives only. With `<= 0n` mutant the «cap exceeded» path
	// would be replaced with the «must be >= 0» throw, changing error message.
	test('[RC6b] zero capturedMinor is valid (boundary: `< 0n` not `<= 0n`)', () => {
		// Cap-exceeded path fires (0 + 1 > 0), not the «capturedMinor must be >= 0» path.
		expect(() =>
			assertRefundCap({ capturedMinor: 0n, currentSumMinor: 0n, newAmountMinor: 1n }),
		).toThrow(/Refund cap exceeded: 0 \+ 1 > 0/)
	})

	test('[RC6c] zero currentSumMinor is valid (boundary)', () => {
		// currentSum=0 + new=100 ≤ cap=1000 → no throw (the `<= 0n` mutant
		// would throw with «currentSumMinor must be >= 0»).
		expect(() =>
			assertRefundCap({ capturedMinor: 1000n, currentSumMinor: 0n, newAmountMinor: 100n }),
		).not.toThrow()
	})

	const validArgsArb = fc
		.tuple(
			fc.bigInt({ min: 0n, max: 1_000_000n }),
			fc.bigInt({ min: 0n, max: 1_000_000n }),
			fc.bigInt({ min: 1n, max: 1_000_000n }),
		)
		.map(([cap, sum, newAmount]) => ({
			capturedMinor: cap,
			currentSumMinor: sum,
			newAmountMinor: newAmount,
		}))

	test('[RC7] property: throws iff sum + new > captured', () => {
		void fc.assert(
			fc.property(validArgsArb, (args) => {
				const willExceed = args.currentSumMinor + args.newAmountMinor > args.capturedMinor
				if (willExceed) {
					expect(() => assertRefundCap(args)).toThrow(/Refund cap exceeded/)
				} else {
					expect(() => assertRefundCap(args)).not.toThrow()
				}
			}),
		)
	})
})

/* ============================================================ refundHeadroomMinor */

describe('refundHeadroomMinor', () => {
	test('[HR1] captured > sum → captured - sum', () => {
		expect(refundHeadroomMinor(1000n, 300n)).toBe(700n)
	})

	test('[HR2] captured === sum → 0 (no headroom)', () => {
		expect(refundHeadroomMinor(1000n, 1000n)).toBe(0n)
	})

	test('[HR3] captured < sum → 0 (clamped, no negative headroom)', () => {
		// This shouldn't normally happen (canon #1 prevents it) but the
		// helper clamps defensively rather than returning negative.
		expect(refundHeadroomMinor(1000n, 1500n)).toBe(0n)
	})

	test('[HR4] negative inputs throw RangeError', () => {
		expect(() => refundHeadroomMinor(-1n, 0n)).toThrow(/capturedMinor must be >= 0/)
		expect(() => refundHeadroomMinor(100n, -1n)).toThrow(/sumSucceededMinor must be >= 0/)
	})

	// Stryker 2026-05-13: kill `< 0n` ↔ `<= 0n` boundary mutants on lines 122/125.
	// Zero is a valid input (uncaptured payment); only negatives must throw.
	test('[HR5] zero capturedMinor returns 0 (boundary: `< 0n` not `<= 0n`)', () => {
		expect(refundHeadroomMinor(0n, 0n)).toBe(0n)
	})

	test('[HR6] zero sumSucceededMinor returns full captured (boundary)', () => {
		expect(refundHeadroomMinor(500n, 0n)).toBe(500n)
	})

	// Line 129 `headroom > 0n ? headroom : 0n` → `>= 0n` is a Stryker EQUIVALENT
	// mutant: both branches return 0n when headroom is 0n (one returns the
	// variable, the other returns the literal — same value). Cannot be killed
	// by any test; documented here so it stays «known equivalent» across runs.
})

/* =================================================== hasActiveCausality */

describe('hasActiveCausality — duplicate-trigger detection', () => {
	const userId = 'usr_01abc00000000000000000000a'
	const disputeId = 'dsp_01abc00000000000000000000a'
	const paymentId = 'pay_01abc00000000000000000000a'

	test('[HC1] empty list → false', () => {
		expect(hasActiveCausality([], { kind: 'userInitiated', userId })).toBe(false)
	})

	test('[HC2] matching succeeded → true', () => {
		const refunds = [{ causalityId: `userInitiated:${userId}`, status: 'succeeded' as const }]
		expect(hasActiveCausality(refunds, { kind: 'userInitiated', userId })).toBe(true)
	})

	test('[HC3] matching pending → true', () => {
		const refunds = [{ causalityId: `dispute:${disputeId}`, status: 'pending' as const }]
		expect(hasActiveCausality(refunds, { kind: 'dispute', disputeId })).toBe(true)
	})

	test('[HC4] matching failed → false (failed allows retry)', () => {
		const refunds = [{ causalityId: `dispute:${disputeId}`, status: 'failed' as const }]
		expect(hasActiveCausality(refunds, { kind: 'dispute', disputeId })).toBe(false)
	})

	test('[HC5] non-matching → false', () => {
		const refunds = [{ causalityId: `userInitiated:${userId}`, status: 'succeeded' as const }]
		const otherUser = 'usr_01abc00000000000000000000b'
		expect(hasActiveCausality(refunds, { kind: 'userInitiated', userId: otherUser })).toBe(false)
	})

	test('[HC6] all 3 causality kinds detected', () => {
		const refunds = [
			{ causalityId: `userInitiated:${userId}`, status: 'succeeded' as const },
			{ causalityId: `dispute:${disputeId}`, status: 'pending' as const },
			{ causalityId: `tkassa_cancel:${paymentId}`, status: 'succeeded' as const },
		]
		expect(hasActiveCausality(refunds, { kind: 'userInitiated', userId })).toBe(true)
		expect(hasActiveCausality(refunds, { kind: 'dispute', disputeId })).toBe(true)
		expect(hasActiveCausality(refunds, { kind: 'tkassa_cancel', paymentId })).toBe(true)
	})

	test('[HC7] null causalityId never matches', () => {
		const refunds: Pick<Refund, 'causalityId' | 'status'>[] = [
			{ causalityId: null, status: 'succeeded' },
		]
		expect(hasActiveCausality(refunds, { kind: 'userInitiated', userId })).toBe(false)
	})
})

/* =================================================== isTerminalRefund + canTransitionRefund */

describe('isTerminalRefund — exhaustive enum', () => {
	test('[TR1] succeeded → true', () => {
		expect(isTerminalRefund('succeeded')).toBe(true)
	})
	test('[TR2] failed → true', () => {
		expect(isTerminalRefund('failed')).toBe(true)
	})
	test('[TR3] pending → false', () => {
		expect(isTerminalRefund('pending')).toBe(false)
	})
})

describe('canTransitionRefund — full transition matrix', () => {
	test('[CT1+CT2+CT3] pending → {succeeded, failed} allowed; pending forbidden', () => {
		expect(canTransitionRefund('pending', 'succeeded')).toBe(true)
		expect(canTransitionRefund('pending', 'failed')).toBe(true)
		expect(canTransitionRefund('pending', 'pending')).toBe(false)
	})

	test('[CT4] succeeded → any forbidden (terminal)', () => {
		for (const to of ALL_STATUSES) {
			expect(canTransitionRefund('succeeded', to)).toBe(false)
		}
	})

	test('[CT5] failed → any forbidden (terminal)', () => {
		for (const to of ALL_STATUSES) {
			expect(canTransitionRefund('failed', to)).toBe(false)
		}
	})
})

describe('assertTransitionRefund', () => {
	test('[AT1] allowed transition does not throw', () => {
		expect(() => assertTransitionRefund('pending', 'succeeded')).not.toThrow()
		expect(() => assertTransitionRefund('pending', 'failed')).not.toThrow()
	})

	test('[AT2] forbidden transition throws with both endpoints in message', () => {
		expect(() => assertTransitionRefund('succeeded', 'pending')).toThrow(
			/Forbidden Refund SM transition: 'succeeded' → 'pending'/,
		)
		expect(() => assertTransitionRefund('failed', 'succeeded')).toThrow(
			/Forbidden Refund SM transition: 'failed' → 'succeeded'/,
		)
	})
})
