/**
 * Demo funnel — empirical integration smoke против live `demo.sepshn.ru`.
 *
 * Pointed at production deployment (NOT local webserver). Matches `smoke`
 * Playwright project (anonymous, no auth.setup dependency).
 *
 * Covers acquisition path which `app-a11y.spec.ts` does NOT test end-to-end:
 *   - [E1] fresh signup → magic-link → /welcome → org create → /o/{slug}/setup
 *   - [E2] **return-visit** — same email later → land in SAME tenant (not duplicate)
 *
 * Why prod URL not local:
 *   - DemoInboxAdapter requires `DEMO_DEPLOYMENT=true` (set in prod, not in
 *     local test webServer config).
 *   - Verifies actual deployed behaviour, not «works on my machine».
 *   - Trade-off: leaves test tenants в prod YDB (per user's product decision
 *     no auto-cleanup — accumulation is by design for return-visit).
 *
 * To run:
 *   pnpm exec playwright test demo-funnel-smoke --project=smoke
 *
 * Run cadence: pre-commit когда trogannye auth/signup/welcome/setup routes.
 * NOT in pre-push (network calls к prod = flaky if internet hiccups).
 */
import { expect, test } from '@playwright/test'

const PROD_BASE = 'https://demo.sepshn.ru'

test.describe('Demo funnel — empirical против prod', () => {
	test.use({
		storageState: { cookies: [], origins: [] },
		baseURL: PROD_BASE,
	})

	test.beforeEach(async ({ page }) => {
		// Mock external Yandex.Metrika tag — canon «no real network в тестах»
		// + защита от случайного traffic'а в real counter.
		await page.route('**/mc.yandex.ru/metrika/**', (route) =>
			route.fulfill({
				status: 200,
				contentType: 'application/javascript',
				body: '/* mocked */',
			}),
		)
	})

	/**
	 * Captures magic-link verify URL из DemoInboxAdapter с polling.
	 * Returns undefined если link не captured в timeout window.
	 */
	async function fetchMagicLink(
		request: import('@playwright/test').APIRequestContext,
		email: string,
		excludeUrl?: string,
	): Promise<string | undefined> {
		for (let i = 0; i < 20; i++) {
			const res = await request.get(
				`${PROD_BASE}/api/public/demo/inbox?email=${encodeURIComponent(email)}`,
			)
			const json = (await res.json()) as { data?: { latestUrl?: string } }
			const url = json?.data?.latestUrl
			if (url !== undefined && url !== excludeUrl) return url
			await new Promise((r) => setTimeout(r, 500))
		}
		return undefined
	}

	test('[E1] fresh signup → magic-link → /welcome → org create → /o/{slug}', async ({
		page,
		request,
	}) => {
		const ts = Date.now()
		const email = `e2e-fresh-${ts}@example.invalid`
		const orgName = `Тестовый отель ${ts}`

		// POST magic-link signin с callbackURL → /welcome?n=<orgName>
		const callbackURL = `${PROD_BASE}/welcome?n=${encodeURIComponent(orgName)}`
		const signupRes = await request.post(`${PROD_BASE}/api/auth/sign-in/magic-link`, {
			data: { email, callbackURL },
		})
		expect(signupRes.status()).toBe(200)

		// Poll DemoInbox для captured URL
		const magicLink = await fetchMagicLink(request, email)
		expect(magicLink, 'Magic-link не captured в DemoInbox в timeout').toBeTruthy()

		// Visit verify URL — sets session cookie + redirects к callbackURL
		await page.goto(magicLink as string)

		// Should land на /welcome
		await expect(page).toHaveURL(/\/welcome/, { timeout: 10_000 })
		await expect(page.getByRole('heading', { name: /Почти готово/ })).toBeVisible()

		// Submit form (orgName prefilled from query)
		await page.getByRole('button', { name: /Создать гостиницу/ }).click()

		// Should land в /o/{slug}/ ИЛИ /o/{slug}/setup
		await expect(page).toHaveURL(/\/o\/[^/]+/, { timeout: 15_000 })
	})

	test('[E2] return-visit — same email → SAME tenant (не duplicate)', async ({ page, request }) => {
		const ts = Date.now()
		const email = `e2e-return-${ts}@example.invalid`

		// === FIRST VISIT — create tenant ===
		const orgName1 = `Первый отель ${ts}`
		const callbackURL1 = `${PROD_BASE}/welcome?n=${encodeURIComponent(orgName1)}`
		await request.post(`${PROD_BASE}/api/auth/sign-in/magic-link`, {
			data: { email, callbackURL: callbackURL1 },
		})
		const magicLink1 = await fetchMagicLink(request, email)
		expect(magicLink1, 'First visit: magic-link не captured').toBeTruthy()

		await page.goto(magicLink1 as string)
		await expect(page).toHaveURL(/\/welcome/, { timeout: 10_000 })
		await page.getByRole('button', { name: /Создать гостиницу/ }).click()
		await expect(page).toHaveURL(/\/o\/[^/]+/, { timeout: 15_000 })

		const orgSlug1 = page.url().match(/\/o\/([^/]+)/)?.[1]
		expect(orgSlug1, 'First visit: orgSlug должен быть в URL').toBeTruthy()

		// === RETURN VISIT — clear cookies, signup again same email ===
		await page.context().clearCookies()
		// Try to confuse the system — different orgName на этот раз. Real return
		// visitor might type a different name OR same name; either way data
		// should NOT duplicate.
		const orgName2 = `Совершенно другое название ${ts}`
		const callbackURL2 = `${PROD_BASE}/welcome?n=${encodeURIComponent(orgName2)}`
		await request.post(`${PROD_BASE}/api/auth/sign-in/magic-link`, {
			data: { email, callbackURL: callbackURL2 },
		})
		const magicLink2 = await fetchMagicLink(request, email, magicLink1)
		expect(magicLink2, 'Return visit: second magic-link не captured').toBeTruthy()
		expect(magicLink2).not.toBe(magicLink1)

		await page.goto(magicLink2 as string)

		// КРИТИЧЕСКАЯ ASSERTION: should NOT land на /welcome (rendered form
		// would let user create duplicate org). Acceptable destinations:
		//   - /o/{orgSlug1}/* — perfect (return-visit canon правильный)
		//   - /o-select — sub-optimal но не создаёт duplicate (user picks)
		//   - НЕ /welcome — это bug
		await page.waitForURL(/\/(welcome|o\/[^/]+|o-select)/, { timeout: 10_000 })
		const finalUrl = page.url()

		// Anti-regression: /welcome rendered means duplicate org will be created
		// when user clicks submit. Per user product canon «return-visit → данные
		// на месте», this is unacceptable.
		expect(finalUrl, 'Return-visit landed на /welcome — duplicate org bug').not.toMatch(
			/\/welcome(\?|$)/,
		)

		// Strong assertion: if в /o/{slug}/, должен быть SAME slug как первый visit.
		if (/\/o\/[^/]+/.test(finalUrl)) {
			const orgSlug2 = finalUrl.match(/\/o\/([^/]+)/)?.[1]
			expect(orgSlug2, 'Return-visit landed в DIFFERENT tenant (duplicate created)').toBe(orgSlug1)
		}
		// /o-select acceptable (user clicks but не создаёт duplicate)
	})
})
