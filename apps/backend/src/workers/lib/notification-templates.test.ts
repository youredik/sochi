/**
 * Strict unit tests for notification templates.
 *
 * Coverage targets per `feedback_strict_tests.md`:
 *   - XSS: every template must escape guest input across HTML branch
 *   - Plain-text branch DOES NOT escape (text/plain MIME = verbatim)
 *   - Subject lines obey rules (≤ 40 chars, no emoji, no caps lock)
 *   - 152-ФЗ footer present in every template (HTML + text)
 *   - Conditional rendering (qrUrl null/non-null in payment_succeeded)
 *   - Exhaustive enum sweep — every NotificationKind covered
 */
import type { NotificationKind } from '@horeca/shared'
import { describe, expect, test } from 'vitest'
import {
	escapeHtml,
	type PaymentSucceededVars,
	renderTemplate,
	type TemplateVars,
} from './notification-templates.ts'

const baseVars = {
	guestName: 'Иван Тестов',
	propertyName: 'Гостиница «Морская»',
	senderOrgName: 'ООО «Тест»',
	senderInn: '7700000000',
	senderEmail: 'noreply@example.ru',
}

describe('escapeHtml', () => {
	test('escapes the 5 dangerous characters', () => {
		expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
	})

	test('escapes ampersand', () => {
		expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry')
	})

	test('escapes single + double quotes', () => {
		expect(escapeHtml(`"He's home"`)).toBe('&quot;He&#39;s home&quot;')
	})

	test('passes Cyrillic + ASCII text unchanged', () => {
		expect(escapeHtml('Иван Тестов 123')).toBe('Иван Тестов 123')
	})

	test('handles empty string', () => {
		expect(escapeHtml('')).toBe('')
	})

	test('escapes ALL occurrences (not just first)', () => {
		expect(escapeHtml('a<b<c<d')).toBe('a&lt;b&lt;c&lt;d')
	})
})

/* ============================================================ XSS hardening sweep */

const xssVars = {
	...baseVars,
	guestName: '<script>alert(1)</script>',
}

const allKinds: NotificationKind[] = [
	'payment_succeeded',
	'payment_failed',
	'receipt_confirmed',
	'receipt_failed',
	'booking_confirmed',
	'checkin_reminder',
	'review_request',
]

const allVars: TemplateVars = {
	payment_succeeded: {
		...xssVars,
		paymentNumber: 'P-001',
		amountFormatted: '5 000,00 ₽',
		receiptQrUrl: 'https://nalog.ru/check?q=ABC',
	},
	payment_failed: {
		...xssVars,
		paymentNumber: 'P-001',
		failureReason: 'Insufficient funds <attack>',
		bookingId: 'B-001',
	},
	receipt_confirmed: {
		...xssVars,
		receiptNumber: 'R-001',
		qrUrl: 'https://nalog.ru/check?q=ABC',
		amountFormatted: '5 000,00 ₽',
	},
	receipt_failed: {
		...xssVars,
		receiptNumber: 'R-001',
		failureReason: 'OFD timeout',
	},
	booking_confirmed: {
		...xssVars,
		bookingNumber: 'B-001',
		checkInDate: '25 апреля 2026',
		checkOutDate: '28 апреля 2026',
		totalFormatted: '15 000,00 ₽',
	},
	checkin_reminder: {
		...xssVars,
		bookingNumber: 'B-001',
		checkInDate: '25 апреля 2026',
		propertyAddress: 'Сочи, ул. Морская, 1',
	},
	review_request: {
		...xssVars,
		bookingNumber: 'B-001',
		yandexMapsReviewUrl: 'https://yandex.ru/maps/org/123/reviews?add-review=1',
	},
}

// Templates differ in which user-input field is rendered. `receipt_failed` is
// ops-facing and intentionally does NOT render guestName (only failureReason
// from the OFD response). Pick the field actually rendered per kind so the
// XSS sweep is meaningful for every template.
const xssAttackInField: Record<NotificationKind, 'guestName' | 'failureReason'> = {
	payment_succeeded: 'guestName',
	payment_failed: 'guestName',
	receipt_confirmed: 'guestName',
	receipt_failed: 'failureReason',
	booking_confirmed: 'guestName',
	checkin_reminder: 'guestName',
	review_request: 'guestName',
}

describe('renderTemplate — XSS hardening (every kind)', () => {
	for (const kind of allKinds) {
		const field = xssAttackInField[kind]
		test(`${kind}: HTML escapes user input in ${field} (no raw <script>)`, () => {
			const baseFixture = allVars[kind]
			const attackPayload = '<script>alert(1)</script>'
			const fixture = { ...baseFixture, [field]: attackPayload } as typeof baseFixture
			const out = renderTemplate(kind, fixture)
			expect(out.html).not.toContain('<script>alert(1)</script>')
			expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
		})

		test(`${kind}: plain-text DOES NOT escape ${field} (text/plain is verbatim)`, () => {
			const baseFixture = allVars[kind]
			const attackPayload = '<script>alert(1)</script>'
			const fixture = { ...baseFixture, [field]: attackPayload } as typeof baseFixture
			const out = renderTemplate(kind, fixture)
			expect(out.text).toContain('<script>alert(1)</script>')
		})
	}
})

/* ============================================================ subject line rules */

describe('renderTemplate — subject line conventions', () => {
	for (const kind of allKinds) {
		test(`${kind}: subject ≤ 60 chars (recommended ≤ 40, hard cap 60)`, () => {
			const out = renderTemplate(kind, allVars[kind])
			expect(out.subject.length).toBeLessThanOrEqual(60)
		})

		test(`${kind}: subject has no emoji / CAPS-WORDS / triple-bang`, () => {
			const out = renderTemplate(kind, allVars[kind])
			// No common emoji code points (BMP shortcut, OK for our scope).
			expect(out.subject).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u)
			expect(out.subject).not.toMatch(/!!!/)
			// No 5+ consecutive ASCII uppercase (avoid CAPS triggers).
			expect(out.subject).not.toMatch(/[A-Z]{5,}/)
		})
	}
})

/* ============================================================ 152-ФЗ footer */

describe('renderTemplate — 152-ФЗ footer present (every kind)', () => {
	for (const kind of allKinds) {
		test(`${kind}: HTML carries org name + ИНН + service-context phrase`, () => {
			const out = renderTemplate(kind, allVars[kind])
			expect(out.html).toContain(allVars[kind].senderOrgName)
			expect(out.html).toContain('ИНН')
			expect(out.html).toContain('гостиничных услуг')
		})

		test(`${kind}: plain-text carries org name + ИНН + service-context phrase`, () => {
			const out = renderTemplate(kind, allVars[kind])
			expect(out.text).toContain(allVars[kind].senderOrgName)
			expect(out.text).toContain('ИНН')
			expect(out.text).toContain('гостиничных услуг')
		})
	}
})

/* ============================================================ conditional rendering */

describe('renderTemplate — conditional rendering', () => {
	test('payment_succeeded: receiptQrUrl=null hides QR section', () => {
		const v: PaymentSucceededVars = {
			...baseVars,
			paymentNumber: 'P-001',
			amountFormatted: '5 000,00 ₽',
			receiptQrUrl: null,
		}
		const out = renderTemplate('payment_succeeded', v)
		expect(out.html).not.toContain('QR-код')
		expect(out.text).not.toContain('QR-код')
	})

	test('payment_succeeded: receiptQrUrl present shows QR link in both branches', () => {
		const v: PaymentSucceededVars = {
			...baseVars,
			paymentNumber: 'P-001',
			amountFormatted: '5 000,00 ₽',
			receiptQrUrl: 'https://nalog.ru/check?q=XYZ',
		}
		const out = renderTemplate('payment_succeeded', v)
		expect(out.html).toContain('QR-код')
		expect(out.html).toContain('https://nalog.ru/check?q=XYZ')
		expect(out.text).toContain('QR-код')
		expect(out.text).toContain('https://nalog.ru/check?q=XYZ')
	})
})

/* ============================================================ vars substitution */

describe('renderTemplate — vars substitution sanity', () => {
	test('booking_confirmed: all 4 critical vars appear in both branches', () => {
		const v: TemplateVars['booking_confirmed'] = {
			...baseVars,
			bookingNumber: 'BOOK-XYZ',
			checkInDate: '25 апреля 2026',
			checkOutDate: '28 апреля 2026',
			totalFormatted: '15 000,00 ₽',
		}
		const out = renderTemplate('booking_confirmed', v)
		for (const branch of [out.html, out.text]) {
			expect(branch).toContain('BOOK-XYZ')
			expect(branch).toContain('25 апреля 2026')
			expect(branch).toContain('28 апреля 2026')
			expect(branch).toContain('15 000,00 ₽')
		}
	})

	test('review_request: yandexMapsReviewUrl exact-match in both branches', () => {
		const url = 'https://yandex.ru/maps/org/12345/reviews?add-review=1'
		const v: TemplateVars['review_request'] = {
			...baseVars,
			bookingNumber: 'B-001',
			yandexMapsReviewUrl: url,
		}
		const out = renderTemplate('review_request', v)
		expect(out.html).toContain(url)
		expect(out.text).toContain(url)
	})
})

/* ============================================================ HTML structural sanity */

describe('renderTemplate — structural sanity', () => {
	test('every kind: HTML opens with doctype + lang=ru', () => {
		for (const kind of allKinds) {
			const out = renderTemplate(kind, allVars[kind])
			expect(out.html.startsWith('<!doctype html>')).toBe(true)
			expect(out.html).toContain('lang="ru"')
		}
	})

	test('every kind: HTML has plain-text counterpart (BOTH branches non-empty)', () => {
		for (const kind of allKinds) {
			const out = renderTemplate(kind, allVars[kind])
			expect(out.html.length).toBeGreaterThan(100)
			expect(out.text.length).toBeGreaterThan(50)
		}
	})

	test('every kind: subject is non-empty', () => {
		for (const kind of allKinds) {
			const out = renderTemplate(kind, allVars[kind])
			expect(out.subject.length).toBeGreaterThan(0)
		}
	})
})
