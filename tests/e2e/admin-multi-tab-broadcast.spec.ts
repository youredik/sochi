import { test } from './_fixtures.ts'
import { expect } from '@playwright/test'
import { getMagicLinkUrl, purgeMailpit } from './_mailpit-helper.ts'
/**
 * Multi-tab BroadcastChannel auth-state propagation — adversarial e2e
 * surfaced by A.bis.5 senior self-audit 2026-05-12 (initial bug-hunt
 * listed this как target но gap не закрыт).
 *
 * Production contract per `apps/frontend/src/lib/broadcast-auth.ts`:
 *   - `logout` broadcast → every other tab invalidates session query
 *     + redirects to /login
 *   - `org:change` broadcast → peer tab re-resolves active org +
 *     follows to new /o/{slug}/
 *
 * Without this spec, a regression in `_app.tsx` useEffect
 * `subscribeAuthBroadcasts({ onLogout, onOrgChange })` wiring would
 * silently kill multi-tab sync — discovery only via user-reported
 * incident ("logged out in one tab, other tab still showed admin").
 *
 * Test method: open 2 pages on the SAME `BrowserContext` (shared
 * BroadcastChannel scope per MDN spec). Post a `logout` message from
 * tab A directly via `page.evaluate(() => new
 * BroadcastChannel('horeca.auth').postMessage({...}))`. Assert tab B
 * navigates to /login.
 *
 * Auth: chromium project storageState (owner.json). Single browser
 * context = both tabs share cookies + BroadcastChannel namespace.
 */

test.describe('admin multi-tab BroadcastChannel propagation', () => {
	test('LogoutButton click in tab A → tab B navigates to /login (production flow)', async ({
		browser,
		request,
	}) => {
		test.setTimeout(60_000)
		// Production-realistic flow: tab A calls `authClient.signOut()` (server
		// invalidates cookie) + `broadcastLogout()`. Tab B receives broadcast,
		// reloadDocument:true (BUG-BH8 fix) → fresh session fetch returns null
		// → /_app guard redirects к /login. This catches the regression where
		// peer-tab navigation skips reloadDocument and bounces off /login's
		// cached-session check.
		//
		// **Isolation note (2026-05-14):** Uses ephemeral JIT-signup user (NOT
		// the shared owner-w*.json) because signOut invalidates the session
		// server-side in YDB. Reusing owner-w0.json here killed every chromium
		// spec downstream that read the same dead cookie. Pattern mirrors the
		// isolated logout test в auth.spec.ts.
		const ts = Date.now()
		const email = `e2e-broadcast-${ts}@sochi.local`
		const orgName = `Broadcast Hotel ${ts}`

		await purgeMailpit(request)

		const context = await browser.newContext()
		const signupPage = await context.newPage()
		try {
			await signupPage.goto('/signup')
			await signupPage.getByLabel('Email').fill(email)
			await signupPage.getByLabel('Название гостиницы').fill(orgName)
			await signupPage.getByLabel(/согласие/).check()
			await signupPage.getByRole('button', { name: 'Получить ссылку для регистрации' }).click()
			await expect(signupPage.getByText('Письмо отправлено')).toBeVisible()

			const magicLinkUrl = await getMagicLinkUrl(request, email)
			await signupPage.goto(magicLinkUrl)
			await expect(signupPage.getByRole('heading', { name: 'Почти готово' })).toBeVisible()
			await Promise.all([
				signupPage.waitForURL(/\/o\/[^/]+\/setup$/),
				signupPage.getByRole('button', { name: 'Создать гостиницу →' }).click(),
			])
			await signupPage.close()

			// Two-tab BroadcastChannel exercise on the ephemeral tenant.
			const tabA = await context.newPage()
			const tabB = await context.newPage()
			try {
				await Promise.all([tabA.goto('/'), tabB.goto('/')])
				await Promise.all([
					expect(tabA).toHaveURL(/\/o\/[^/]+\/(?:setup|.*)/),
					expect(tabB).toHaveURL(/\/o\/[^/]+\/(?:setup|.*)/),
				])

				// Click LogoutButton in tab A — production path. Triggers
				// authClient.signOut() (server invalidates) + broadcastLogout()
				// + tab A reloadDocument к /login.
				await tabA.getByRole('button', { name: /Выйти|Выходим/ }).click()

				// Tab B should receive the broadcast и reloadDocument к /login.
				// Allow generous timeout: server signOut + broadcast latency +
				// reloadDocument full page reload + /_app guard 401 detection.
				await expect(tabB).toHaveURL(/\/login(\?.*)?$/, { timeout: 10_000 })
			} finally {
				await tabA.close()
				await tabB.close()
			}
		} finally {
			await context.close()
		}
	})

	test('unknown broadcast version (v: 999) is silently ignored — forward-compat', async ({
		context,
	}) => {
		const tabA = await context.newPage()
		const tabB = await context.newPage()
		try {
			await Promise.all([tabA.goto('/'), tabB.goto('/')])
			await Promise.all([
				expect(tabA).toHaveURL(/\/o\/[^/]+\/?$/),
				expect(tabB).toHaveURL(/\/o\/[^/]+\/?$/),
			])
			const initialUrlB = tabB.url()

			// Post a future-version unknown message. Per `broadcast-auth.ts:67-71`
			// the listener filters `msg.v !== 1`. Tab B must NOT navigate.
			await tabA.evaluate(() => {
				const ch = new BroadcastChannel('horeca.auth')
				ch.postMessage({ v: 999, type: 'logout' })
				ch.close()
			})

			// Wait a beat, then assert URL unchanged. 1.5s gives the message
			// loop + any potential reactive query roundtrip time to fire.
			await tabB.waitForTimeout(1500)
			expect(tabB.url()).toBe(initialUrlB)
		} finally {
			await tabA.close()
			await tabB.close()
		}
	})
})
