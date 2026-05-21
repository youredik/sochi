/**
 * `magicLinkEmail` template — strict tests (per `feedback_strict_tests.md`).
 *
 *   [S1] subject is the exact canonical Russian phrase
 *   [U1] signInUrl appears in <a href=""> AND in text/plain body
 *   [U2] signInUrl appears as visible link text for the fallback copy/paste
 *        line (so a client that strips `<a>` still gets a clickable URL)
 *   [E1] expiryMinutes value renders verbatim in both HTML and text
 *   [E2] different expiry values produce different bodies (no hard-coded 5)
 *   [P1] anti-phishing security copy present in both formats
 *   [X1] URL-injection guard: special chars passed through don't break HTML
 *        (we accept signed URLs as-is — BA produces safe URLs; no escaping
 *        layer here, but we should at least notice if the consumer breaks).
 */
import { describe, expect, test } from 'bun:test'
import { magicLinkEmail } from './magic-link-email.ts'

describe('magicLinkEmail', () => {
	test('[S1] subject is the exact canonical Russian phrase', () => {
		const { subject } = magicLinkEmail({
			signInUrl: 'https://example.com/magic-link/verify?token=abc',
			expiryMinutes: 5,
		})
		expect(subject).toBe('Вход в Сэпшн — ваша одноразовая ссылка')
	})

	test('[U1] signInUrl appears in <a href=""> AND in text/plain', () => {
		const url = 'https://example.com/magic-link/verify?token=specific123'
		const { html, text } = magicLinkEmail({ signInUrl: url, expiryMinutes: 5 })
		expect(html.includes(`href="${url}"`)).toBe(true)
		expect(text.includes(url)).toBe(true)
	})

	test('[U2] signInUrl rendered in three positions — primary CTA href + fallback href + fallback visible text', () => {
		const url = 'https://example.com/magic-link/verify?token=visible456'
		const { html } = magicLinkEmail({ signInUrl: url, expiryMinutes: 5 })
		// URL appears 3× in HTML: (1) primary "Войти" button href, (2) fallback
		// copy-paste paragraph anchor href, (3) fallback paragraph visible text
		// for clients that strip <a> tags entirely.
		const count = html.split(url).length - 1
		expect(count).toBe(3)
	})

	test('[E1] expiryMinutes value renders verbatim in both HTML and text', () => {
		const { html, text } = magicLinkEmail({
			signInUrl: 'https://example.com/magic-link/verify?token=abc',
			expiryMinutes: 7,
		})
		expect(html.includes('<strong>7 минут</strong>')).toBe(true)
		expect(text.includes('действует 7 минут')).toBe(true)
	})

	test('[E2] different expiry values produce different bodies', () => {
		const a = magicLinkEmail({
			signInUrl: 'https://example.com/m',
			expiryMinutes: 5,
		})
		const b = magicLinkEmail({
			signInUrl: 'https://example.com/m',
			expiryMinutes: 10,
		})
		expect(a.html).not.toBe(b.html)
		expect(a.text).not.toBe(b.text)
	})

	test('[P1] anti-phishing security copy present in both HTML and text', () => {
		const { html, text } = magicLinkEmail({
			signInUrl: 'https://example.com/m',
			expiryMinutes: 5,
		})
		expect(html.includes('Не передавайте эту ссылку никому')).toBe(true)
		expect(text.includes('Не передавайте ссылку никому')).toBe(true)
		expect(html.includes('игнорируйте это письмо')).toBe(true)
		expect(text.includes('игнорируйте это письмо')).toBe(true)
	})

	test('[X1] URL passed through without modification (consumer responsibility)', () => {
		const url = 'https://api.horeca.local/auth/magic-link/verify?token=abc&callbackURL=%2Fdash'
		const { html } = magicLinkEmail({ signInUrl: url, expiryMinutes: 5 })
		expect(html.includes(url)).toBe(true)
	})
})
