/**
 * Unit tests for dispute shared schemas.
 *
 * Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):
 *   [X] disputeStatusSchema: 5 values FULL enum coverage + reject unknown
 *   [X] TERMINAL_DISPUTE_STATUSES: exact set (won/lost/expired)
 *   [X] disputeOpenInput: providerCode FULL enum coverage (5 values)
 *   [X] disputeOpenInput: amountMinor strictly > 0n
 *   [X] disputeOpenInput: currency literal 'RUB' only (V1 single-currency)
 *   [X] disputeOpenInput: dueAt ISO 8601 datetime strict
 *   [X] disputeSubmitEvidenceInput: arbitrary record (caller composes JSON)
 *   [X] disputeResolveInput: outcomeStatus = won|lost|expired (terminal only)
 *   [X] DISPUTE_REPRESENTMENT_BLOCK_DAYS: exact 180 (canon network rule)
 *   [X] reasonCode boundary (1..50 chars)
 */

import { describe, expect, it } from 'vitest'
import {
	DISPUTE_REPRESENTMENT_BLOCK_DAYS,
	disputeOpenInput,
	disputeResolveInput,
	disputeStatusSchema,
	disputeSubmitEvidenceInput,
	TERMINAL_DISPUTE_STATUSES,
} from './dispute.ts'

const validOpen = () =>
	({
		providerCode: 'yookassa' as const,
		reasonCode: '4853',
		amountMinor: 100000n,
		currency: 'RUB' as const,
		dueAt: '2026-05-15T12:00:00.000Z',
	}) satisfies Record<string, unknown>

describe('disputeStatusSchema (5 enum values FULL)', () => {
	it.each([
		'opened',
		'evidence_submitted',
		'won',
		'lost',
		'expired',
	] as const)('accepts %s', (v) => {
		expect(disputeStatusSchema.safeParse(v).success).toBe(true)
	})

	it('rejects unknown status', () => {
		expect(disputeStatusSchema.safeParse('disputed').success).toBe(false)
	})
})

describe('TERMINAL_DISPUTE_STATUSES', () => {
	it('is exactly {won, lost, expired}', () => {
		expect([...TERMINAL_DISPUTE_STATUSES].sort()).toEqual(['expired', 'lost', 'won'])
	})

	it('does NOT include opened or evidence_submitted (non-terminal)', () => {
		const set = new Set(TERMINAL_DISPUTE_STATUSES)
		expect(set.has('opened' as never)).toBe(false)
		expect(set.has('evidence_submitted' as never)).toBe(false)
	})
})

describe('disputeOpenInput', () => {
	it('accepts a valid base payload', () => {
		expect(disputeOpenInput.safeParse(validOpen()).success).toBe(true)
	})

	it.each([
		'stub',
		'yookassa',
		'tkassa',
		'sbp',
		'digital_ruble',
	] as const)('accepts providerCode = %s (FULL enum coverage)', (code) => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), providerCode: code }).success).toBe(true)
	})

	it('rejects unknown providerCode', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), providerCode: 'paypal' }).success).toBe(
			false,
		)
	})

	it('rejects amountMinor = 0n (must be > 0)', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), amountMinor: 0n }).success).toBe(false)
	})

	it('rejects negative amountMinor', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), amountMinor: -1n }).success).toBe(false)
	})

	it('accepts amountMinor at Int64 max boundary', () => {
		expect(
			disputeOpenInput.safeParse({
				...validOpen(),
				amountMinor: 9_223_372_036_854_775_807n,
			}).success,
		).toBe(true)
	})

	it('rejects amountMinor exceeding Int64 max', () => {
		expect(
			disputeOpenInput.safeParse({
				...validOpen(),
				amountMinor: 9_223_372_036_854_775_808n,
			}).success,
		).toBe(false)
	})

	it('rejects currency != RUB (V1 single-currency)', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), currency: 'USD' }).success).toBe(false)
	})

	it('rejects empty reasonCode', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), reasonCode: '' }).success).toBe(false)
	})

	it('rejects reasonCode > 50 chars', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), reasonCode: 'a'.repeat(51) }).success).toBe(
			false,
		)
	})

	it('accepts reasonCode at exactly 50 chars (upper boundary)', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), reasonCode: 'a'.repeat(50) }).success).toBe(
			true,
		)
	})

	it.each([
		'2026-05-15T12:00:00.000Z',
		'2026-05-15T12:00:00Z',
		'2026-05-15T12:00:00.000+03:00',
	])('dueAt accepts ISO datetime: %s', (v) => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), dueAt: v }).success).toBe(true)
	})

	it.each([
		'2026-05-15',
		'not-a-date',
		'15/05/2026',
		'',
		'2026-13-45T99:99:99Z',
	])('dueAt rejects non-ISO: %s', (v) => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), dueAt: v }).success).toBe(false)
	})

	it('providerDisputeId accepts null', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), providerDisputeId: null }).success).toBe(
			true,
		)
	})

	it('providerDisputeId rejects empty string', () => {
		expect(disputeOpenInput.safeParse({ ...validOpen(), providerDisputeId: '' }).success).toBe(
			false,
		)
	})
})

describe('disputeSubmitEvidenceInput', () => {
	it('accepts arbitrary nested object', () => {
		expect(
			disputeSubmitEvidenceInput.safeParse({
				evidenceJson: { docs: ['url1', 'url2'], notes: 'guest signed contract' },
			}).success,
		).toBe(true)
	})

	it('accepts empty object', () => {
		expect(disputeSubmitEvidenceInput.safeParse({ evidenceJson: {} }).success).toBe(true)
	})

	it('rejects evidenceJson = null', () => {
		expect(disputeSubmitEvidenceInput.safeParse({ evidenceJson: null }).success).toBe(false)
	})

	it('rejects evidenceJson missing entirely', () => {
		expect(disputeSubmitEvidenceInput.safeParse({}).success).toBe(false)
	})
})

describe('disputeResolveInput', () => {
	it.each(['won', 'lost', 'expired'] as const)('accepts outcomeStatus = %s (terminal)', (s) => {
		expect(disputeResolveInput.safeParse({ outcomeStatus: s, outcome: 'foo' }).success).toBe(true)
	})

	it.each([
		'opened',
		'evidence_submitted',
	] as const)('rejects outcomeStatus = %s (non-terminal — only resolves to terminal)', (s) => {
		expect(disputeResolveInput.safeParse({ outcomeStatus: s }).success).toBe(false)
	})

	it('outcome = null is allowed (no provider message)', () => {
		expect(disputeResolveInput.safeParse({ outcomeStatus: 'won', outcome: null }).success).toBe(
			true,
		)
	})

	it('outcome rejects > 2000 chars (DB column bound)', () => {
		expect(
			disputeResolveInput.safeParse({
				outcomeStatus: 'lost',
				outcome: 'a'.repeat(2001),
			}).success,
		).toBe(false)
	})
})

describe('DISPUTE_REPRESENTMENT_BLOCK_DAYS', () => {
	it('equals exactly 180 (canon: card network re-presentment window)', () => {
		expect(DISPUTE_REPRESENTMENT_BLOCK_DAYS).toBe(180)
	})
})
