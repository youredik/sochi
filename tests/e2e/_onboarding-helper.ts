import { type APIRequestContext, expect, type Page } from '@playwright/test'
import { getMagicLinkUrl, purgeMailpit } from './_mailpit-helper.ts'

/**
 * Passwordless signup → magic-link → land on `/o/{slug}/setup` — the CURRENT
 * canonical onboarding prefix.
 *
 * Round 14.6.2 (2026-05-28): the /signup form captures ONLY email + consent
 * (NO orgName — the hotel name comes later from ИНН/DaData, one source of
 * truth), and /welcome `beforeLoad` AUTO-creates the org (placeholder name +
 * `org-<base36>` slug) with NO UI interaction → the empty-tenant dashboard
 * guard then redirects to /setup.
 *
 * Extracted so `auth.setup.ts` (owner fixture) and the setup-wizard a11y audit
 * share ONE flow and can never drift from each other — that drift is exactly
 * what silently broke the a11y audit (it kept filling a `Название гостиницы`
 * field removed in 14.6.2).
 *
 * @returns the freshly-created org slug (`org-…`).
 */
export async function signupToSetup(
	page: Page,
	request: APIRequestContext,
	email: string,
): Promise<string> {
	// Purge Mailpit first so `getMagicLinkUrl(email)` matches the freshly-sent
	// message, not a stale one from a prior run.
	await purgeMailpit(request)

	await page.goto('/signup')
	await expect(page.getByRole('heading', { name: 'Регистрация' })).toBeVisible()
	await page.getByLabel('Email').fill(email)
	await page.getByLabel(/согласие/).check()
	await page.getByRole('button', { name: 'Получить ссылку для регистрации' }).click()
	// Confirmation surfaces «Письмо отправлено» + the email itself (NOT orgName).
	await expect(page.getByText('Письмо отправлено')).toBeVisible()
	await expect(page.getByText(email)).toBeVisible()

	const magicLinkUrl = await getMagicLinkUrl(request, email)
	await page.goto(magicLinkUrl)

	// /welcome auto-creates the org (no UI) → /setup. Slug is `org-…`, not
	// name-derived, so the URL match is generic.
	await page.waitForURL(/\/o\/[^/?]+\/setup$/)
	const slug = page.url().match(/\/o\/([^/?]+)\/setup$/)?.[1] ?? ''
	expect(slug).not.toBe('')
	return slug
}
