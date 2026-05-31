import type { Page } from '@playwright/test'
import { buildConsentState, STORAGE_KEY } from '../../apps/frontend/src/lib/cookie-consent.ts'

/**
 * Pre-grant cookie-consent categories BEFORE any page script runs, by seeding
 * the `cookie-consent` localStorage record via `addInitScript` (Playwright
 * canon for pre-seeded storage — runs before app bootstrap, so the app reads
 * the value on first navigation).
 *
 * The record is built with the app's OWN `buildConsentState` + `STORAGE_KEY`
 * (single source of truth) — NO hardcoded schema/version here, so a consent
 * schema bump in `cookie-consent.ts` can never silently desync the e2e.
 *
 * Used by the Metrika deferred-init smoke (analytics is a 152-ФЗ opt-in gate;
 * without consent `window.ym` is never created).
 */
export async function grantConsent(
	page: Page,
	categories: { analytics?: boolean; marketing?: boolean } = { analytics: true },
): Promise<void> {
	const value = JSON.stringify(buildConsentState(categories))
	await page.addInitScript(
		({ key, value }) => {
			window.localStorage.setItem(key, value)
		},
		{ key: STORAGE_KEY, value },
	)
}
