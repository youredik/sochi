import AxeBuilder from '@axe-core/playwright'
import { expect } from '@playwright/test'
import { test } from './_fixtures.ts'

/**
 * AI review-reply E2E (2026-05-30) — proves the feature is VISIBLE in the
 * always-on demo and works end-to-end in a real browser on the prod runtime.
 *
 * The owner storageState org is `mode='demo'` (afterCreateOrganization), so the
 * `/reviews` route loader provisions the canonical demo review set under the
 * org's REAL property via an idempotent POST (`provisionDemoReviews` → write
 * semantics; the list GET stays safe). Closes the gap where seeded reviews lived
 * only in the static `demo-sochi-sirius` tenant.
 *
 * WCAG 2.2 AA via @axe-core/playwright (a11y gate canon).
 */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

test.describe('AI review-reply', () => {
	test('reviews page shows provisioned demo reviews + passes WCAG 2.2 AA', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="reviews"]').first().click()
		await expect(page).toHaveURL(/\/reviews$/)
		await expect(page.getByRole('heading', { name: 'Отзывы', level: 1 })).toBeVisible()

		// Demo-provisioning (loader POST): the canonical demo reviews appear.
		await expect(page.getByText('Мария Иванова')).toBeVisible()
		await expect(page.getByText('Алексей')).toBeVisible()
		// Summary card derived from the seeded set.
		await expect(page.getByText('Сводка по отзывам')).toBeVisible()
		// New reviews show the AI-draft entry point.
		await expect(page.getByRole('button', { name: /Подготовить ответ ИИ/ }).first()).toBeVisible()

		const results = await new AxeBuilder({ page }).include('main').withTags(WCAG_TAGS).analyze()
		if (results.violations.length > 0) {
			console.error('axe violations:', JSON.stringify(results.violations, null, 2))
		}
		expect(results.violations).toEqual([])
	})

	test('AI draft → publish flow (real YandexGPT) flips status to published', async ({ page }) => {
		await page.goto('/')
		await page.locator('[data-section-id="reviews"]').first().click()
		await expect(page).toHaveURL(/\/reviews$/)

		// Drive the YandexGPT draft on the first new review.
		await page
			.getByRole('button', { name: /Подготовить ответ ИИ/ })
			.first()
			.click()

		// Real AI — generous wait. Assert the reply textarea appears non-empty
		// (meaning, not exact content — the model output varies).
		const textarea = page.getByLabel('Ответ гостю').first()
		await expect(textarea).toBeVisible({ timeout: 30_000 })
		await expect(textarea).not.toHaveValue('', { timeout: 30_000 })

		// Publish back to the channel (Mock publisher) → status flips.
		await page
			.getByRole('button', { name: /^Опубликовать/ })
			.first()
			.click()
		await expect(page.getByText('Ответ опубликован')).toBeVisible({ timeout: 15_000 })
		await expect(page.getByText('Опубликован').first()).toBeVisible()
	})
})
