/**
 * Unit tests for `validateExpiryAgainstStay` (Round 8 P1-3 / Canon P0 #3).
 *
 * Per `project_passport_scan_canon_2026_05_22.md` line 122:
 *   «expirationDate ≤ today или expirationDate < bookingEnd → red banner.
 *    ЕПГУ отвергнет регистрацию с истёкшим документом».
 *
 * Helper centralizes 3-branch logic так что parent dialog не carries math.
 */
import { describe, expect, test } from 'bun:test'
import { validateExpiryAgainstStay } from './validate-expiry.ts'

describe('validateExpiryAgainstStay — Round 8 P1-3 / Canon P0 #3', () => {
	const today = '2026-05-25'

	test('[E1] expiry < today → expired error (no stay context needed)', () => {
		const result = validateExpiryAgainstStay({
			expiryIso: '2026-05-20',
			todayIso: today,
			checkOutIso: '2026-06-15',
		})
		expect(result.ok).toBe(false)
		expect(result.error).toBe(
			'Документ истёк 2026-05-20. Гость должен предъявить действующий документ.',
		)
	})

	test('[E2] expiry === today → expired (boundary; valid-through-end-of-day NOT assumed)', () => {
		const result = validateExpiryAgainstStay({
			expiryIso: '2026-05-25',
			todayIso: today,
			checkOutIso: '2026-06-15',
		})
		// Same-day expiry — ЕПГУ rejects (registration MUST be at least 1 day).
		// Treat as valid TODAY but invalid for any stay ending after today.
		expect(result.ok).toBe(false)
		expect(result.error).toContain('истекает в период проживания')
	})

	test('[E3] expiry >= today AND expiry < checkOut → expires-during-stay error (DD.MM.YYYY format)', () => {
		const result = validateExpiryAgainstStay({
			expiryIso: '2026-06-15',
			todayIso: today,
			checkOutIso: '2026-06-25',
		})
		expect(result.ok).toBe(false)
		expect(result.error).toBe(
			'Документ истекает в период проживания. Гость должен предъявить документ, действующий до конца брони (до 25.06.2026).',
		)
	})

	test('[E4] expiry >= checkOut → valid through stay (no error)', () => {
		const result = validateExpiryAgainstStay({
			expiryIso: '2026-06-25',
			todayIso: today,
			checkOutIso: '2026-06-25',
		})
		// Boundary: expiry === checkOut. Guest's document valid through the
		// final stay day — ЕПГУ registers since checkout day Itself is covered.
		expect(result.ok).toBe(true)
		expect(result.error).toBeUndefined()
	})

	test('[E5] expiry well past checkOut → valid (canonical happy path)', () => {
		const result = validateExpiryAgainstStay({
			expiryIso: '2030-01-01',
			todayIso: today,
			checkOutIso: '2026-06-25',
		})
		expect(result.ok).toBe(true)
		expect(result.error).toBeUndefined()
	})

	test('[E6] no checkOutIso provided → fallback to today-only check (backward-compat)', () => {
		// Caller without booking context (rescan-section before booking link)
		// degrades gracefully: only check «expired vs today».
		const futureValid = validateExpiryAgainstStay({
			expiryIso: '2026-06-15',
			todayIso: today,
			checkOutIso: null,
		})
		expect(futureValid.ok).toBe(true)

		const expired = validateExpiryAgainstStay({
			expiryIso: '2026-05-20',
			todayIso: today,
			checkOutIso: null,
		})
		expect(expired.ok).toBe(false)
		expect(expired.error).toBe(
			'Документ истёк 2026-05-20. Гость должен предъявить действующий документ.',
		)
	})

	test('[E7] checkOutIso malformed → fallback to today-only check (defense-in-depth)', () => {
		// Caller passes garbage — helper degrades to today-only check rather
		// than crash. Validates `/^\d{4}-\d{2}-\d{2}$/`.
		const result = validateExpiryAgainstStay({
			expiryIso: '2026-06-15',
			todayIso: today,
			checkOutIso: 'not-a-date',
		})
		expect(result.ok).toBe(true)
	})

	test('[E8] expiryIso malformed → invalid date error', () => {
		const result = validateExpiryAgainstStay({
			expiryIso: '15-06-2026',
			todayIso: today,
			checkOutIso: '2026-06-25',
		})
		expect(result.ok).toBe(false)
		expect(result.error).toBe('Срок действия — некорректная дата')
	})
})
