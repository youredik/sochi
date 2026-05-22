/**
 * isFullscreenWizardRoute — strict tests (2026-05-22 onboarding fullscreen).
 *
 * Pre-done audit:
 *   [W1] /o/{slug}/setup → true (canonical wizard root)
 *   [W2] /o/{slug}/setup/identify → true (future sub-route stays fullscreen)
 *   [W3] /setup → true (no orgSlug prefix; defensive)
 *   [W4] /o/{slug}/grid → false (admin shell route)
 *   [W5] /setup-history → false (not a /setup segment — substring trap)
 *   [W6] /o/setup-helper/grid → false («setup-helper» is не сегмент `setup`)
 *   [W7] / → false (root)
 *   [W8] empty string → false
 */
import { describe, expect, it } from 'bun:test'
import { isFullscreenWizardRoute } from './is-fullscreen-wizard-route.ts'

describe('isFullscreenWizardRoute — wizard fullscreen detection', () => {
	it('[W1] canonical /o/{slug}/setup → true', () => {
		expect(isFullscreenWizardRoute('/o/horeca-demo/setup')).toBe(true)
	})

	it('[W2] sub-route /o/{slug}/setup/identify → true (entire setup subtree)', () => {
		expect(isFullscreenWizardRoute('/o/horeca-demo/setup/identify')).toBe(true)
	})

	it('[W3] /setup (no orgSlug) → true', () => {
		expect(isFullscreenWizardRoute('/setup')).toBe(true)
	})

	it('[W4] /o/{slug}/grid → false (admin shell)', () => {
		expect(isFullscreenWizardRoute('/o/horeca-demo/grid')).toBe(false)
	})

	it('[W5] /setup-history → false (substring not segment)', () => {
		expect(isFullscreenWizardRoute('/setup-history')).toBe(false)
	})

	it('[W6] /o/setup-helper/grid → false (token in middle ≠ segment match)', () => {
		expect(isFullscreenWizardRoute('/o/setup-helper/grid')).toBe(false)
	})

	it('[W7] root / → false', () => {
		expect(isFullscreenWizardRoute('/')).toBe(false)
	})

	it('[W8] empty string → false', () => {
		expect(isFullscreenWizardRoute('')).toBe(false)
	})
})
