import { expect, test } from '@playwright/test'

/**
 * Wizard-specific adversarial tests. Run under `chromium` project with
 * storageState from auth.setup.ts (owner has already completed wizard).
 * That means `/o/{slug}/setup` for this owner is reachable as a bare
 * route (parent `_app/o/$orgSlug` validates slug membership) BUT the
 * wizard-store is fresh each page load (in-memory Zustand).
 *
 * Hunts:
 *   - duplicate room.number 409 surfaces as toast (UNIQUE constraint on
 *     tenantId+roomTypeId+number at DB level)
 *   - cross-tenant URL `/o/{otherSlug}/setup` redirects away (not leak)
 *   - wizard-store starts fresh on page reload (not localStorage-cached)
 */

test.describe('setup wizard adversarial', () => {
	test('cross-tenant URL /o/not-your-slug/setup redirects away', async ({ page }) => {
		await page.goto('/o/definitely-not-your-org/setup')
		// _app/o/$orgSlug guard: slug ∉ user.orgs → redirect to '/', which
		// then resolves to the owner's own org. URL must NOT contain the
		// adversarial slug.
		await expect(page).not.toHaveURL(/definitely-not-your-org/)
	})

	test('wizard-store has no localStorage persistence — step 1 fresh on direct navigation', async ({
		page,
	}) => {
		await page.goto('/')
		// Wait for dashboard URL (not /setup — owner has property already).
		await expect(page).toHaveURL(/\/o\/e2e-hotel-\d+\/?$/)
		const match = page.url().match(/\/o\/([^/?]+)/)
		const orgSlug = match?.[1]
		expect(orgSlug).toBeTruthy()

		await page.goto(`/o/${orgSlug}/setup`)
		// Step 1 is rendered (wizard-store fresh; no localStorage ghost).
		await expect(page.getByLabel('Название гостиницы')).toBeVisible()
		await expect(page.getByLabel('Адрес')).toBeVisible()
	})
})
