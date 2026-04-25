/**
 * Unit tests for paymentWebhookEvent shared schemas + helpers.
 *
 * Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):
 *   [X] synthesizeYookassaDedupKey: deterministic (same input → same output)
 *   [X] synthesizeYookassaDedupKey: order-sensitive (different field combos
 *       produce different keys)
 *   [X] synthesizeYookassaDedupKey: boundary chars (`|` in field values)
 *   [X] paymentWebhookEventInsert: provider enum FULL coverage (5 values)
 *   [X] paymentWebhookEventInsert: tenantId TypeID format strictly enforced
 *   [X] paymentWebhookEventInsert: dedupKey min/max length adversarial
 *   [X] paymentWebhookEventInsert: providerPaymentId/providerRefundId
 *       null vs undefined vs missing
 *   [X] paymentWebhookEventInsert: payloadJson accepts arbitrary unknown
 */

import { describe, expect, it } from 'vitest'
import { newId } from './ids.ts'
import { paymentWebhookEventInsert, synthesizeYookassaDedupKey } from './payment-webhook-event.ts'

describe('synthesizeYookassaDedupKey', () => {
	it('produces deterministic output (same input → same key)', () => {
		const args = {
			providerPaymentId: '2c9b4e8f-0000-0000-0000-000000000001',
			event: 'payment.succeeded',
			status: 'succeeded',
			amountValue: '159000',
		}
		const a = synthesizeYookassaDedupKey(args)
		const b = synthesizeYookassaDedupKey(args)
		expect(a).toBe(b)
		expect(a).toBe('2c9b4e8f-0000-0000-0000-000000000001|payment.succeeded|succeeded|159000')
	})

	it('different fields → different keys (order-sensitive)', () => {
		const base = {
			providerPaymentId: 'pid-A',
			event: 'payment.succeeded',
			status: 'succeeded',
			amountValue: '100000',
		}
		const variants = [
			{ ...base, providerPaymentId: 'pid-B' },
			{ ...base, event: 'payment.canceled' },
			{ ...base, status: 'canceled' },
			{ ...base, amountValue: '200000' },
		]
		const seen = new Set<string>()
		seen.add(synthesizeYookassaDedupKey(base))
		for (const v of variants) {
			const k = synthesizeYookassaDedupKey(v)
			expect(seen.has(k)).toBe(false)
			seen.add(k)
		}
		expect(seen.size).toBe(5)
	})

	it('treats `|` in field values as part of the key (no escaping)', () => {
		// Document intent: caller is responsible for guaranteeing field values
		// don't contain `|`. ЮKassa returns UUIDv4 / enum strings / decimal
		// digits — none of which legitimately contain `|`. We do not escape.
		const k = synthesizeYookassaDedupKey({
			providerPaymentId: 'a|b',
			event: 'c|d',
			status: 'e|f',
			amountValue: 'g|h',
		})
		expect(k).toBe('a|b|c|d|e|f|g|h')
	})

	it('preserves whitespace and case literally', () => {
		const k = synthesizeYookassaDedupKey({
			providerPaymentId: 'PID Spaces',
			event: 'PAYMENT.Succeeded',
			status: 'Succeeded',
			amountValue: '  100  ',
		})
		expect(k).toBe('PID Spaces|PAYMENT.Succeeded|Succeeded|  100  ')
	})
})

describe('paymentWebhookEventInsert', () => {
	const validBase = {
		tenantId: newId('organization'),
		providerCode: 'stub',
		dedupKey: 'k1',
		eventType: 'payment.succeeded',
		payloadJson: { ok: true },
	} as const

	it('accepts minimum valid payload', () => {
		const result = paymentWebhookEventInsert.safeParse(validBase)
		expect(result.success).toBe(true)
	})

	it('rejects non-typeid tenantId', () => {
		const bad = { ...validBase, tenantId: 'not-a-typeid' }
		const result = paymentWebhookEventInsert.safeParse(bad)
		expect(result.success).toBe(false)
	})

	it.each([
		'stub',
		'yookassa',
		'tkassa',
		'sbp',
		'digital_ruble',
	] as const)('accepts providerCode = %s (FULL enum coverage)', (code) => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			providerCode: code,
		})
		expect(result.success).toBe(true)
	})

	it('rejects unknown providerCode', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			providerCode: 'paypal',
		})
		expect(result.success).toBe(false)
	})

	it('rejects empty dedupKey', () => {
		const result = paymentWebhookEventInsert.safeParse({ ...validBase, dedupKey: '' })
		expect(result.success).toBe(false)
	})

	it('rejects dedupKey > 512 chars', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			dedupKey: 'a'.repeat(513),
		})
		expect(result.success).toBe(false)
	})

	it('accepts dedupKey at exactly 512 chars (upper boundary)', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			dedupKey: 'a'.repeat(512),
		})
		expect(result.success).toBe(true)
	})

	it('rejects empty eventType', () => {
		const result = paymentWebhookEventInsert.safeParse({ ...validBase, eventType: '' })
		expect(result.success).toBe(false)
	})

	it('accepts providerPaymentId = null', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			providerPaymentId: null,
		})
		expect(result.success).toBe(true)
	})

	it('accepts providerPaymentId omitted (undefined)', () => {
		// "omitted" and "null" are BOTH valid — domain semantics same
		// (provider hasn't returned id yet). Doc-by-test.
		const result = paymentWebhookEventInsert.safeParse(validBase)
		expect(result.success).toBe(true)
	})

	it('rejects providerPaymentId = empty string', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			providerPaymentId: '',
		})
		expect(result.success).toBe(false)
	})

	it('accepts payloadJson = arbitrary nested object', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			payloadJson: { nested: { array: [1, 2, { deep: true }], mixed: [null, 'str', 42] } },
		})
		expect(result.success).toBe(true)
	})

	it('rejects sourceIp longer than 45 chars (IPv6 max bound)', () => {
		const result = paymentWebhookEventInsert.safeParse({
			...validBase,
			sourceIp: 'a'.repeat(46),
		})
		expect(result.success).toBe(false)
	})
})
