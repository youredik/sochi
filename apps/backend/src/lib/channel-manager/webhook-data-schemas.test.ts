/**
 * Round 14 Phase E3 — per-channel webhook data zod validation tests.
 */

import { describe, expect, test } from 'bun:test'
import { validateWebhookData } from './webhook-data-schemas.ts'

describe('webhook data schemas (Round 14 E3)', () => {
	test('[WHDS1] unknown eventType+channel → no_schema (forward-compat)', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.unknown.future.v1',
			channelId: 'YT',
			data: { foo: 'bar' },
		})
		expect(r.kind).toBe('no_schema')
	})

	test('[WHDS2] YT booking.created valid data → ok', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.channel.booking.created.v1',
			channelId: 'YT',
			data: {
				order_id: 'yt-order-abc123',
				external_id: 'ext-1',
				channel_id: 'YT',
				hotel_id: 'demo-hotel-sochi',
				check_in: '2027-08-15',
				check_out: '2027-08-17',
				adults: 2,
				children: 0,
				total_price_rub: 12000,
				currency: 'RUB',
			},
		})
		expect(r.kind).toBe('ok')
	})

	test('[WHDS3] YT booking.created missing required field → invalid', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.channel.booking.created.v1',
			channelId: 'YT',
			data: {
				// missing order_id
				external_id: 'ext-1',
				channel_id: 'YT',
				hotel_id: 'demo-hotel-sochi',
				check_in: '2027-08-15',
				check_out: '2027-08-17',
				adults: 2,
				total_price_rub: 12000,
				currency: 'RUB',
			},
		})
		expect(r.kind).toBe('invalid')
		if (r.kind === 'invalid') {
			expect(r.errors.some((e) => e.includes('order_id'))).toBe(true)
		}
	})

	test('[WHDS4] YT booking.created malformed date → invalid', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.channel.booking.created.v1',
			channelId: 'YT',
			data: {
				order_id: 'yt-order-abc',
				external_id: 'ext-1',
				channel_id: 'YT',
				hotel_id: 'h',
				check_in: '2027/08/15', // wrong format
				check_out: '2027-08-17',
				adults: 2,
				total_price_rub: 100,
				currency: 'RUB',
			},
		})
		expect(r.kind).toBe('invalid')
	})

	test('[WHDS5] YT booking.created с wrong channel_id literal → invalid (channel mismatch defense)', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.channel.booking.created.v1',
			channelId: 'YT',
			data: {
				order_id: 'x',
				external_id: 'x',
				channel_id: 'ETG', // mismatched literal — caught by zod literal check
				hotel_id: 'h',
				check_in: '2027-08-15',
				check_out: '2027-08-17',
				adults: 2,
				total_price_rub: 100,
				currency: 'RUB',
			},
		})
		expect(r.kind).toBe('invalid')
	})

	test('[WHDS6] ETG booking.created valid → ok', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.channel.booking.created.v1',
			channelId: 'ETG',
			data: {
				partner_order_id: '0184a052-e087-4b35-b41f-7733e20366f7',
				book_hash: 'abc123',
				channel_id: 'ETG',
				hid: 8473727,
				check_in: '2027-08-15',
				check_out: '2027-08-17',
				total_price: 28000,
				currency_code: 'RUB',
			},
		})
		expect(r.kind).toBe('ok')
	})

	test('[WHDS7] TL ari.delta valid → ok', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.channel.ari.delta.v1',
			channelId: 'TL',
			data: {
				channel_id: 'TL',
				property_code: 'prop-1',
				room_type_id: 'rt-1',
				rate_plan_id: 'rp-1',
				date: '2027-08-15',
			},
		})
		expect(r.kind).toBe('ok')
	})

	test('[WHDS8] YK payment.succeeded valid → ok', () => {
		const r = validateWebhookData({
			eventType: 'app.sochi.payment.succeeded.v1',
			channelId: 'YK',
			data: {
				payment_id: 'pay_abc',
				amount: { value: '12000.00', currency: 'RUB' },
				status: 'succeeded',
			},
		})
		expect(r.kind).toBe('ok')
	})
})
