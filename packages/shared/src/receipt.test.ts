/**
 * Unit tests for receipt shared schemas (54-ФЗ ФФД 1.2 fiscal tags).
 *
 * Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):
 *   [X] receiptKindSchema: 5 values FULL enum coverage + reject unknown
 *   [X] receiptStatusSchema: 5 values FULL coverage + reject unknown
 *   [X] receiptProviderSchema: 3 values FULL + reject unknown (incl. yookassa
 *       which is the PAYMENT provider, not RECEIPT provider — common confusion)
 *   [X] receiptTag1054: 1..4 boundary; 0 and 5 reject
 *   [X] receiptTag1212: literal 4 only; 1/2/3/5 reject
 *   [X] receiptTag1214: 1..4 boundary; 0 and 5 reject
 *   [X] receiptTag1199: literal 5 only; non-5 reject (canon: 0% НДС accommodation)
 *   [X] receiptLineSchema: positive quantity/price/sum bigint coercion
 *   [X] receiptCreateInput: tag1008 email valid + E.164 phone valid + invalid format reject
 *   [X] receiptCreateInput: lines min(1)/max(100) boundaries
 *   [X] receiptCreateInput: idempotencyKey UUID v4 strict; non-UUID reject
 *   [X] receiptCreateInput: optional fields null vs undefined
 *   [X] TERMINAL_RECEIPT_STATUSES: exact set (confirmed/failed/corrected)
 *   [X] RECEIPT_CORRECTION_CHAIN_MAX_DEPTH: exact value 3 (54-ФЗ regulatory)
 */

import { describe, expect, it } from 'vitest'
import { newId } from './ids.ts'
import {
	RECEIPT_CORRECTION_CHAIN_MAX_DEPTH,
	receiptCreateInput,
	receiptKindSchema,
	receiptLineSchema,
	receiptProviderSchema,
	receiptStatusSchema,
	receiptTag1054Schema,
	receiptTag1199Schema,
	receiptTag1212Schema,
	receiptTag1214Schema,
	TERMINAL_RECEIPT_STATUSES,
} from './receipt.ts'

const VALID_LINE = {
	name: 'Проживание 25-27 апреля',
	quantity: 1n,
	priceMinor: 159000n,
	sumMinor: 159000n,
	tag1199: 5,
	tag1212: 4,
	tag1214: 4,
} as const

const validBase = () =>
	({
		kind: 'final' as const,
		provider: 'yookassa_cheki' as const,
		tag1054: 1 as const,
		tag1212: 4 as const,
		tag1214: 4 as const,
		tag1199: 5 as const,
		tag1008: 'guest@example.com',
		lines: [VALID_LINE],
		totalMinor: 159000n,
		idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
	}) satisfies Record<string, unknown>

describe('receiptKindSchema (5 enum values FULL)', () => {
	it.each([
		'advance',
		'prepayment_full',
		'final',
		'refund',
		'correction',
	] as const)('accepts %s', (v) => {
		expect(receiptKindSchema.safeParse(v).success).toBe(true)
	})

	it('rejects unknown kind', () => {
		expect(receiptKindSchema.safeParse('invoice').success).toBe(false)
	})
})

describe('receiptStatusSchema (5 enum values FULL)', () => {
	it.each(['pending', 'sent', 'confirmed', 'failed', 'corrected'] as const)('accepts %s', (v) => {
		expect(receiptStatusSchema.safeParse(v).success).toBe(true)
	})

	it('rejects unknown status', () => {
		expect(receiptStatusSchema.safeParse('void').success).toBe(false)
	})
})

describe('receiptProviderSchema (3 enum values FULL)', () => {
	it.each(['yookassa_cheki', 'atol_online', 'stub'] as const)('accepts %s', (v) => {
		expect(receiptProviderSchema.safeParse(v).success).toBe(true)
	})

	it('rejects payment provider name (yookassa) — that is the PAYMENT provider, not RECEIPT', () => {
		expect(receiptProviderSchema.safeParse('yookassa').success).toBe(false)
	})

	it('rejects unknown provider', () => {
		expect(receiptProviderSchema.safeParse('atol_offline').success).toBe(false)
	})
})

describe('FFD 1.2 tag schemas — exact-value spec', () => {
	it.each([1, 2, 3, 4])('tag1054 accepts %i', (v) => {
		expect(receiptTag1054Schema.safeParse(v).success).toBe(true)
	})

	it.each([0, 5, 6, -1])('tag1054 rejects %i (out of 1..4)', (v) => {
		expect(receiptTag1054Schema.safeParse(v).success).toBe(false)
	})

	it('tag1212 accepts ONLY 4 (canon: услуга for hotel)', () => {
		expect(receiptTag1212Schema.safeParse(4).success).toBe(true)
	})

	it.each([1, 2, 3, 5, 0])('tag1212 rejects %i (canon: literal 4 only)', (v) => {
		expect(receiptTag1212Schema.safeParse(v).success).toBe(false)
	})

	it.each([1, 2, 3, 4])('tag1214 accepts %i', (v) => {
		expect(receiptTag1214Schema.safeParse(v).success).toBe(true)
	})

	it.each([0, 5, 6, -1])('tag1214 rejects %i', (v) => {
		expect(receiptTag1214Schema.safeParse(v).success).toBe(false)
	})

	it('tag1199 accepts ONLY 5 (canon: НДС 0% accommodation продлено до 31.12.2030)', () => {
		expect(receiptTag1199Schema.safeParse(5).success).toBe(true)
	})

	it.each([0, 1, 2, 3, 4, 6])('tag1199 rejects %i (canon: literal 5 only)', (v) => {
		expect(receiptTag1199Schema.safeParse(v).success).toBe(false)
	})
})

describe('receiptLineSchema', () => {
	it('accepts a valid line', () => {
		expect(receiptLineSchema.safeParse(VALID_LINE).success).toBe(true)
	})

	it('rejects empty name', () => {
		expect(receiptLineSchema.safeParse({ ...VALID_LINE, name: '' }).success).toBe(false)
	})

	it('rejects name longer than 128 chars (FFD 1.2 spec limit)', () => {
		expect(receiptLineSchema.safeParse({ ...VALID_LINE, name: 'a'.repeat(129) }).success).toBe(
			false,
		)
	})

	it('accepts name at exactly 128 chars', () => {
		expect(receiptLineSchema.safeParse({ ...VALID_LINE, name: 'a'.repeat(128) }).success).toBe(true)
	})

	it('rejects quantity = 0n (must be > 0)', () => {
		expect(receiptLineSchema.safeParse({ ...VALID_LINE, quantity: 0n }).success).toBe(false)
	})

	it('rejects negative priceMinor', () => {
		expect(receiptLineSchema.safeParse({ ...VALID_LINE, priceMinor: -1n }).success).toBe(false)
	})

	it('accepts priceMinor = 0n (free service)', () => {
		expect(
			receiptLineSchema.safeParse({ ...VALID_LINE, priceMinor: 0n, sumMinor: 0n }).success,
		).toBe(true)
	})

	it('rejects negative sumMinor', () => {
		expect(receiptLineSchema.safeParse({ ...VALID_LINE, sumMinor: -1n }).success).toBe(false)
	})

	it('coerces string numbers to bigint (z.coerce.bigint)', () => {
		const parsed = receiptLineSchema.parse({
			...VALID_LINE,
			quantity: '1' as unknown as bigint,
			priceMinor: '1000' as unknown as bigint,
			sumMinor: '1000' as unknown as bigint,
		})
		expect(parsed.quantity).toBe(1n)
		expect(parsed.priceMinor).toBe(1000n)
	})
})

describe('receiptCreateInput', () => {
	it('accepts a fully-valid base payload', () => {
		expect(receiptCreateInput.safeParse(validBase()).success).toBe(true)
	})

	it.each([
		'guest@example.com',
		'a.b+tag@sub.domain.org',
		'+79991234567',
		'+12025551234',
		'12025551234',
	])('tag1008 accepts valid contact: %s', (v) => {
		expect(receiptCreateInput.safeParse({ ...validBase(), tag1008: v }).success).toBe(true)
	})

	it.each([
		'no-at-no-plus',
		'+12345', // 5 digits, below E.164 min 10
		'1234567890123456', // 16 digits, above E.164 max 15
		'',
	])('tag1008 rejects invalid contact: %s', (v) => {
		expect(receiptCreateInput.safeParse({ ...validBase(), tag1008: v }).success).toBe(false)
	})

	it('tag1008 rejects > 255 chars (DB column bound)', () => {
		const tooLong = `${'a'.repeat(250)}@e.com`
		expect(receiptCreateInput.safeParse({ ...validBase(), tag1008: tooLong }).success).toBe(false)
	})

	it('rejects lines = empty array (min 1)', () => {
		expect(receiptCreateInput.safeParse({ ...validBase(), lines: [] }).success).toBe(false)
	})

	it('rejects lines.length > 100 (max 100)', () => {
		const lines = Array.from({ length: 101 }, () => VALID_LINE)
		expect(receiptCreateInput.safeParse({ ...validBase(), lines }).success).toBe(false)
	})

	it('accepts lines.length = 100 (upper boundary)', () => {
		const lines = Array.from({ length: 100 }, () => VALID_LINE)
		expect(receiptCreateInput.safeParse({ ...validBase(), lines }).success).toBe(true)
	})

	it('rejects totalMinor = 0n (must be > 0)', () => {
		expect(receiptCreateInput.safeParse({ ...validBase(), totalMinor: 0n }).success).toBe(false)
	})

	it('rejects negative totalMinor', () => {
		expect(receiptCreateInput.safeParse({ ...validBase(), totalMinor: -1n }).success).toBe(false)
	})

	it.each([
		'550e8400-e29b-41d4-a716-446655440000', // valid v4
		'00000000-0000-4000-8000-000000000000', // valid v4 boundary
	])('idempotencyKey accepts UUID: %s', (v) => {
		expect(receiptCreateInput.safeParse({ ...validBase(), idempotencyKey: v }).success).toBe(true)
	})

	it.each([
		'not-a-uuid',
		'550e8400-e29b-41d4-a716', // truncated
		'550e8400-e29b-41d4-a716-446655440000-extra',
		'',
	])('idempotencyKey rejects non-UUID: %s', (v) => {
		expect(receiptCreateInput.safeParse({ ...validBase(), idempotencyKey: v }).success).toBe(false)
	})

	it('correctsReceiptId accepts null', () => {
		expect(receiptCreateInput.safeParse({ ...validBase(), correctsReceiptId: null }).success).toBe(
			true,
		)
	})

	it('correctsReceiptId accepts a valid receipt typeid', () => {
		expect(
			receiptCreateInput.safeParse({ ...validBase(), correctsReceiptId: newId('receipt') }).success,
		).toBe(true)
	})

	it('correctsReceiptId rejects non-receipt typeid (e.g. payment)', () => {
		expect(
			receiptCreateInput.safeParse({ ...validBase(), correctsReceiptId: newId('payment') }).success,
		).toBe(false)
	})

	it('refundId accepts null', () => {
		expect(receiptCreateInput.safeParse({ ...validBase(), refundId: null }).success).toBe(true)
	})

	it('refundId accepts a valid refund typeid', () => {
		expect(
			receiptCreateInput.safeParse({ ...validBase(), refundId: newId('refund') }).success,
		).toBe(true)
	})

	it('refundId rejects non-refund typeid (e.g. payment)', () => {
		expect(
			receiptCreateInput.safeParse({ ...validBase(), refundId: newId('payment') }).success,
		).toBe(false)
	})
})

describe('terminal-status set + correction-chain limit', () => {
	it('TERMINAL_RECEIPT_STATUSES is exactly {confirmed, failed, corrected}', () => {
		expect([...TERMINAL_RECEIPT_STATUSES].sort()).toEqual(['confirmed', 'corrected', 'failed'])
	})

	it('RECEIPT_CORRECTION_CHAIN_MAX_DEPTH equals 3 (canon: ФНС regulatory)', () => {
		expect(RECEIPT_CORRECTION_CHAIN_MAX_DEPTH).toBe(3)
	})
})
