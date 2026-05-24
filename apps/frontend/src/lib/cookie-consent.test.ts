/**
 * cookie-consent — strict tests (per `feedback_strict_tests.md`).
 *
 *   [G1] getConsent default state — no decision made, only `necessary=true`
 *   [G2] hasDecided false when no storage entry
 *   [G3] isGranted('necessary') always true (legitimate interest)
 *   [G4] isGranted('analytics') false by default
 *   [S1] setConsent({analytics: true}) persists + readable
 *   [S2] setConsent stores grantedAt as ISO timestamp
 *   [S3] setConsent overwrites prior state
 *   [V1] schema-mismatch storage data → ignored (returns default)
 *   [V2] non-JSON storage data → ignored
 *   [O1] onConsentChange subscriber fired on setConsent
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
	__resetForTesting,
	getConsent,
	hasDecided,
	isGranted,
	onConsentChange,
	setConsent,
} from './cookie-consent.ts'

beforeEach(() => {
	__resetForTesting()
})
afterEach(() => {
	__resetForTesting()
})

describe('cookie-consent', () => {
	test('[G1] getConsent default state — no decision, only necessary=true', () => {
		const c = getConsent()
		expect(c.grantedAt).toBe('')
		expect(c.categories).toEqual({ necessary: true, analytics: false, marketing: false })
	})

	test('[G2] hasDecided false when no storage entry', () => {
		expect(hasDecided()).toBe(false)
	})

	test('[G3] isGranted("necessary") always true', () => {
		expect(isGranted('necessary')).toBe(true)
	})

	test('[G4] isGranted("analytics") false by default', () => {
		expect(isGranted('analytics')).toBe(false)
		expect(isGranted('marketing')).toBe(false)
	})

	test('[S1] setConsent({analytics: true}) persists + readable', () => {
		setConsent({ analytics: true })
		expect(isGranted('analytics')).toBe(true)
		expect(isGranted('marketing')).toBe(false)
		expect(hasDecided()).toBe(true)
	})

	test('[S2] setConsent stores grantedAt as ISO timestamp', () => {
		setConsent({ analytics: true })
		const c = getConsent()
		expect(c.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
	})

	test('[S3] setConsent overwrites prior state', () => {
		setConsent({ analytics: true, marketing: true })
		setConsent({ analytics: false, marketing: false })
		expect(isGranted('analytics')).toBe(false)
		expect(isGranted('marketing')).toBe(false)
		expect(hasDecided()).toBe(true)
	})

	test('[V1] schema-mismatch storage data → ignored (returns default)', () => {
		window.localStorage.setItem(
			'horeca-cookie-consent',
			JSON.stringify({ version: 'old-v1', grantedAt: 'x', categories: {} }),
		)
		__resetForTesting()
		// Reset cleared storage, write again post-reset with stale version.
		window.localStorage.setItem(
			'horeca-cookie-consent',
			JSON.stringify({
				version: 'old-v1',
				grantedAt: '2025-01-01',
				categories: { necessary: true, analytics: true, marketing: false },
			}),
		)
		const c = getConsent()
		// Old schema → treated as undecided
		expect(c.grantedAt).toBe('')
	})

	test('[V2] non-JSON storage data → ignored', () => {
		window.localStorage.setItem('horeca-cookie-consent', '{broken')
		const c = getConsent()
		expect(c.grantedAt).toBe('')
	})

	test('[O1] onConsentChange subscriber fired on setConsent', () => {
		const calls: Parameters<Parameters<typeof onConsentChange>[0]>[0][] = []
		const unsub = onConsentChange((state) => {
			calls.push(state)
		})
		setConsent({ analytics: true })
		expect(calls.length).toBe(1)
		expect(calls[0]?.categories.analytics).toBe(true)
		unsub()
		setConsent({ analytics: false })
		// After unsubscribe → no more callbacks
		expect(calls.length).toBe(1)
	})
})
