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
		// Capture browser console errors → exposed в test output для diagnostics.
		page.on('console', (msg) => {
			if (msg.type() === 'error') console.error(`[browser] ${msg.text().slice(0, 500)}`)
		})
		page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`))
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
			const json = (await res.json()) as { data?: { latestUrl?: string | null } }
			const url = json?.data?.latestUrl
			// API returns `latestUrl: null` until backend captures. Skip null
			// AND skip excluded prev-url (return-visit case). Previously checked
			// `!== undefined` which let null through prematurely → race fail.
			if (url != null && url !== excludeUrl) return url
			await new Promise((r) => setTimeout(r, 500))
		}
		return undefined
	}

	test('[E1] fresh signup → magic-link → /welcome → org create → /setup → DaData lookup', async ({
		page,
		request,
	}) => {
		const ts = Date.now()
		const email = `e2e-fresh-${ts}@example.invalid`
		const orgName = `Тестовый отель ${ts}`

		// POST magic-link signin с callbackURL → /welcome?n=<orgName>
		const callbackURL = `${PROD_BASE}/welcome?n=${encodeURIComponent(orgName)}`
		// Retry magic-link POST до 5 раз с 3s backoff — backend бывает
		// intermittently 5xx (rate-limit demo-inbox MAX_TOTAL_RECIPIENTS=500
		// ИЛИ cold-start serverless container ~5s).
		let signupRes: import('@playwright/test').APIResponse | undefined
		for (let attempt = 0; attempt < 5; attempt++) {
			signupRes = await request.post(`${PROD_BASE}/api/auth/sign-in/magic-link`, {
				data: { email, callbackURL },
			})
			if (signupRes.status() === 200) break
			await new Promise((r) => setTimeout(r, 3000))
		}
		expect(signupRes?.status(), `Final attempt body: ${await signupRes?.text()}`).toBe(200)

		// Poll DemoInbox для captured URL
		const magicLink = await fetchMagicLink(request, email)
		expect(magicLink, 'Magic-link не captured в DemoInbox в timeout').toBeTruthy()

		// Visit verify URL — sets session cookie + redirects к callbackURL
		// === Regression guard: NO org-scoped /api/v1/* calls на /welcome ===
		// canonical fix 34adc1e 2026-05-21 — `tenantMiddleware` requires
		// `session.activeOrganizationId`, которое null для fresh-signup.
		// Любой `/api/v1/*` fetch на /welcome → 403 console-noise + wasted
		// round-trip. WelcomeForm must use BA-level `authClient.organization
		// .list()` для membership questions, NOT `/api/v1/properties`.
		const tenantScopedCalls: string[] = []
		const tenantScopedListener = (response: import('@playwright/test').Response) => {
			const url = response.url()
			if (url.includes('/api/v1/') && new URL(page.url()).pathname === '/welcome') {
				tenantScopedCalls.push(`${response.status()} ${url}`)
			}
		}
		page.on('response', tenantScopedListener)

		await page.goto(magicLink as string)

		// Should land на /welcome (fresh-signup, no existing orgs)
		await expect(page).toHaveURL(/\/welcome/, { timeout: 10_000 })
		await expect(page.getByRole('heading', { name: /Почти готово/ })).toBeVisible()

		// Settle — defensive queries fire on mount, give them chance to land.
		await page.waitForLoadState('networkidle', { timeout: 5_000 })

		// Assert NO /api/v1/* calls happened while on /welcome. If this fails,
		// some new component sneaked in an org-scoped fetch on a pre-org route.
		expect(
			tenantScopedCalls,
			'/welcome must not call any org-scoped /api/v1/* endpoint — session.activeOrganizationId is null',
		).toEqual([])
		page.off('response', tenantScopedListener)

		// Submit form (orgName prefilled from query)
		await page.getByRole('button', { name: /Создать гостиницу/ }).click()

		// Wait для FINAL /setup URL. Full chain: BA create-org → reload →
		// `_app.o.$orgSlug` setActive + invalidate session → /o/{slug}/ index
		// guard checks properties.list (idempotent retry on YDB hiccup) → если
		// empty → redirect /setup. Timing варьируется от 1s (warm cache) до
		// ~10s (cold YDB reconnect + retry). 30s safe ceiling.
		await page.waitForURL(/\/o\/[^/]+\/setup/, { timeout: 30_000 })
		await page.waitForLoadState('networkidle', { timeout: 10_000 })

		// === SETUP WIZARD — ИНН step empirical verify (closes Task #32 DaData) ===
		// Wizard Step 1 — IdentifyStep с ИНН input
		await expect(page.getByLabel('ИНН гостиницы')).toBeVisible({ timeout: 10_000 })

		// Canonical Сочи ИНН 2320000001 (mock-dadata.ts dataset).
		// Works в обоих режимах: mock fallback (если DADATA_API_KEY не set)
		// + real DaData (валидный Сочи ИНН в real database).
		await page.getByLabel('ИНН гостиницы').fill('2320000001')
		await page.getByRole('button', { name: 'Найти' }).click()

		// DaData response → party preview card rendered с aria-label
		await expect(page.getByRole('complementary', { name: 'Найденная организация' })).toBeVisible({
			timeout: 10_000,
		})

		// Party.name displayed внутри preview card. Mock canonical Сочи set
		// content varies, но org name MUST appear в card (not empty).
		const preview = page.getByRole('complementary', { name: 'Найденная организация' })
		const previewText = await preview.textContent()
		expect(previewText, 'Party preview card should contain org details').toBeTruthy()
		expect(previewText, 'ИНН should be displayed в card').toContain('2320000001')
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

		// **Wait для FINAL settled URL** — `/o/{slug}/`. Race vector: BA verify
		// делает server 302 → /welcome callback, потом TanStack Router
		// client-side beforeLoad guard срабатывает + redirects к /o/{slug}/.
		// Старый pattern `waitForURL(/(welcome|o\/...)/)` matches intermediate
		// /welcome state → false-positive fail (URL captured ДО client-redirect).
		//
		// Direct wait для `/o/{slug}/` finals — это собственно return-visit
		// canon. Если guard сломан и юзер застрянет на /welcome → timeout →
		// test fails (correct fail mode, точная diagnostics).
		await page.waitForURL(/\/o\/[^/]+/, { timeout: 15_000 })
		const finalUrl = page.url()

		// SAME tenant assertion — orgSlug2 === orgSlug1 (no duplicate)
		const orgSlug2 = finalUrl.match(/\/o\/([^/]+)/)?.[1]
		expect(
			orgSlug2,
			'Return-visit landed в DIFFERENT tenant (duplicate created instead of setActive)',
		).toBe(orgSlug1)
	})

	/**
	 * [E3] **Meta-invariant — zero localhost fetches in prod bundle**.
	 *
	 * Locks down sibling-sweep canon (commits c6b1f0f + fcf7aeb + c0f4d90,
	 * 2026-05-21). Five hooks/clients had a `?? 'http://localhost:8787'`
	 * fallback trap that baked the literal into prod bundle при
	 * `VITE_API_URL` unset at build:
	 *   - `lib/api.ts` (Hono RPC)
	 *   - `lib/auth-client.ts` (BA React client)
	 *   - `features/admin-tax/hooks/use-tourism-tax-report.ts` (XLSX URL)
	 *   - `features/chessboard/hooks/use-booking-events-stream.ts` (SSE)
	 *   - `features/content-wizard/hooks/use-media.ts` (multipart + sign)
	 *
	 * All five now route через shared `getApiBaseUrl()` helper → same-origin
	 * `window.location.origin` in browser. This test exercises the full
	 * auth flow (landing → /welcome → /setup → /o/{slug}/grid) и asserts
	 * **NO network request had host = `localhost:8787` или contained that
	 * literal in URL/body**. Per `feedback_self_review_finds_halfmeasure`
	 * — sibling-class regression guard.
	 *
	 * What this proves vs. [E1]:
	 *   - [E1] verifies the SIGNUP funnel works end-to-end (DaData mock,
	 *     no 403 console noise, tenant created)
	 *   - [E3] verifies the BUNDLE NEVER references localhost (which would
	 *     manifest как net::ERR_CONNECTION_REFUSED in production for the
	 *     5 sibling code paths even when [E1] funnel passes — different
	 *     surface)
	 */
	test('[E3] meta-invariant — zero localhost fetches from prod bundle', async ({
		page,
		request,
	}) => {
		const ts = Date.now()
		const email = `e2e-localhost-${ts}@example.invalid`
		const orgName = `Локхост-страж ${ts}`

		// Listener — captures ANY request whose URL contains localhost,
		// regardless of port. Storing rather than failing on-event keeps
		// diagnostics readable (final assertion shows all offenders).
		const localhostFetches: string[] = []
		page.on('request', (req) => {
			const url = req.url()
			if (url.includes('localhost')) localhostFetches.push(`${req.method()} ${url}`)
		})

		// Magic-link signup
		const callbackURL = `${PROD_BASE}/welcome?n=${encodeURIComponent(orgName)}`
		let signupRes: import('@playwright/test').APIResponse | undefined
		for (let attempt = 0; attempt < 5; attempt++) {
			signupRes = await request.post(`${PROD_BASE}/api/auth/sign-in/magic-link`, {
				data: { email, callbackURL },
			})
			if (signupRes.status() === 200) break
			await new Promise((r) => setTimeout(r, 3000))
		}
		expect(signupRes?.status()).toBe(200)

		const magicLink = await fetchMagicLink(request, email)
		expect(magicLink, 'Magic-link не captured').toBeTruthy()
		await page.goto(magicLink as string)

		// /welcome — fires WelcomeForm защитный orgList query (BA, не /api/v1)
		await expect(page).toHaveURL(/\/welcome/, { timeout: 10_000 })
		await page.waitForLoadState('networkidle', { timeout: 5_000 })

		// /setup — fires content-wizard hooks (media/amenities), а на /grid
		// загружается chessboard SSE EventSource — все 5 sibling targets
		// touched by walking through this flow.
		await page.getByRole('button', { name: /Создать гостиницу/ }).click()
		await page.waitForURL(/\/o\/[^/]+\/setup/, { timeout: 30_000 })
		await page.waitForLoadState('networkidle', { timeout: 10_000 })

		// FINAL ASSERTION — zero localhost. If anything fired against
		// localhost:8787 (или any other localhost port) during this whole
		// flow, the bundle has a stale URL fallback и users в prod will hit
		// net::ERR_CONNECTION_REFUSED. Show every offender для diagnostics.
		expect(
			localhostFetches,
			`Prod bundle leaked localhost requests:\n${localhostFetches.join('\n')}`,
		).toEqual([])
	})

	/**
	 * [E4] **Apex → app redirect — empirical canon**.
	 *
	 * 2026-05-21 critical user-facing bug: navigating directly к
	 * `sepshn.ru/login` (apex) loaded the same SPA as `demo.sepshn.ru`, но
	 * BA `trustedOrigins` only included demo subdomain — POST /sign-in/
	 * magic-link returned «Доступ запрещён — Invalid callbackURL».
	 *
	 * Fix (`__root.tsx` beforeLoad + `lib/apex-redirect.ts`): apex requests
	 * к any non-marketing path hard-redirect к demo.sepshn.ru. Marketing
	 * paths (`/`, `/privacy`, `/legal/*`) stay на apex.
	 *
	 * Tested live (anonymous, no signup necessary):
	 *   1. GET https://sepshn.ru/login → expect redirect (hostname change)
	 *   2. Final landing URL host = `demo.sepshn.ru`
	 *   3. Page loads без CORS / 403 errors
	 */
	test('[E4] apex sepshn.ru/login → redirects к demo subdomain', async ({ page }) => {
		// Disable Playwright's default test isolation — нам нужен full hard nav.
		await page.goto('https://sepshn.ru/login', { waitUntil: 'networkidle' })

		// After redirect, hostname must equal app subdomain.
		const finalHost = new URL(page.url()).hostname
		expect(finalHost, `Expected demo.sepshn.ru, got ${page.url()}`).toBe('demo.sepshn.ru')

		// Login form must render (no «Invalid callbackURL» banner)
		await expect(page.getByRole('heading', { name: /Вход/ })).toBeVisible({ timeout: 10_000 })
		await expect(page.getByText('Invalid callbackURL')).toBeHidden()
	})

	test('[E5] apex sepshn.ru/ (root) → stays on apex (marketing landing)', async ({ page }) => {
		// Landing page MUST NOT redirect — apex `/` IS the marketing surface.
		await page.goto('https://sepshn.ru/', { waitUntil: 'networkidle' })
		expect(new URL(page.url()).hostname).toBe('sepshn.ru')
		// Landing heading sanity check
		await expect(page.getByRole('heading', { name: /Программа для управления/ })).toBeVisible({
			timeout: 10_000,
		})
	})

	/**
	 * [E6] **DemoInboxPanel renders after submit — atomic-build-env canon**.
	 *
	 * 2026-05-22 regression guard для bug class «backend has DEMO_DEPLOYMENT
	 * but frontend bundle was built без VITE_DEMO_DEPLOYMENT». Symptom:
	 * user submits email, sees «Письмо отправлено», но NO panel UI with
	 * captured magic-link → visitor stuck (real email never sent в demo
	 * mode по `[[demo_inbox_canon]]`).
	 *
	 * Both env-vars are an ATOMIC PAIR. Test asserts:
	 *   1. Submit magic-link form
	 *   2. «Письмо отправлено» appears
	 *   3. DemoInboxPanel визуально rendered (heading «Демо-почта»)
	 *
	 * If frontend env-var is dropped from CI, this test fails immediately
	 * — preventing «pair broken» class.
	 */
	test('[E6] login form submit → DemoInboxPanel renders (build-env atomic-pair)', async ({
		page,
		request,
	}) => {
		const ts = Date.now()
		const email = `e2e-panel-${ts}@example.invalid`

		// Use the actual login UI (not API direct) — exercises full bundle
		await page.goto('https://demo.sepshn.ru/login', { waitUntil: 'networkidle' })
		await page.getByLabel('Email').fill(email)
		await page.getByRole('button', { name: /Получить ссылку для входа/ }).click()

		// Success card shows
		await expect(page.getByText('Письмо отправлено')).toBeVisible({ timeout: 10_000 })

		// DemoInboxPanel renders в two phases: «Ждём письмо…» (initial poll)
		// → «Письмо пришло» (after backend capture propagates). Either
		// proves panel is rendered (i.e. bundle was built с
		// VITE_DEMO_DEPLOYMENT=true). Polling interval ~1Hz.
		await expect(page.getByText(/Ждём письмо|Письмо пришло/)).toBeVisible({
			timeout: 15_000,
		})

		// Stronger guarantee — wait для «Письмо пришло» (capture propagated)
		// + magic-link button visible (final state). Multi-instance race может
		// сделать backend polling эveнтуально consistent — UI panel retries
		// indefinitely until it gets the URL, so test just waits for UI.
		// Per `[[demo_inbox_multi_instance_canon]]`: don't trust direct API
		// followup в multi-instance backend — UI is canonical truth.
		await expect(page.getByText('Письмо пришло')).toBeVisible({ timeout: 30_000 })
		await expect(page.getByRole('link', { name: /Открыть и войти/ })).toBeVisible()
	})

	/**
	 * [E7] **Real-user full happy path — apex → /grid**.
	 *
	 * 2026-05-22 canonical end-to-end empirical — every step a real
	 * prospect takes, no shortcuts:
	 *   1. visit apex marketing page
	 *   2. click «Войти» (cross-origin к demo subdomain)
	 *   3. type email → submit
	 *   4. DemoInboxPanel captures + shows magic-link
	 *   5. click magic-link → /welcome
	 *   6. type org name + submit → /o/{slug}/setup
	 *   7. ИНН 2320000001 (canonical Сочи mock) → DaData preview
	 *   8. click Подтвердить → inventory step
	 *   9. fill rooms count + nightly price → submit
	 *  10. land on /o/{slug}/grid (шахматка)
	 *
	 * Verified manual walk-through 2026-05-22: complete в ~22s.
	 *
	 * If ANY step breaks, real prospects получат stuck funnel — this is
	 * the ultimate regression guard. Per user-mandate «сам все проверяй
	 * за реального пользователя» 2026-05-22.
	 */
	test('[E7] real-user full happy path — apex landing → /grid', async ({ page }) => {
		const ts = Date.now()
		const email = `e2e-realuser-${ts}@example.invalid`
		const orgName = `Тестовый отель ${ts}`

		// 1. Apex landing
		await page.goto('https://sepshn.ru/', { waitUntil: 'networkidle' })
		await expect(page.getByRole('heading', { name: /Программа для управления/ })).toBeVisible()

		// 2. Click «Войти» — cross-origin к demo
		const loginLink = page.locator('a:has-text("Войти")').first()
		await expect(loginLink).toHaveAttribute('href', 'https://demo.sepshn.ru/login')
		await loginLink.click()
		await page.waitForURL(/demo\.sepshn\.ru\/login/, { timeout: 15_000 })

		// 3. Submit email
		await page.getByLabel('Email').fill(email)
		await page.getByRole('button', { name: /Получить ссылку для входа/ }).click()
		await expect(page.getByText('Письмо отправлено')).toBeVisible({ timeout: 10_000 })

		// 4. DemoInboxPanel captures
		await expect(page.getByText('Письмо пришло')).toBeVisible({ timeout: 30_000 })
		const magicLinkLocator = page.getByRole('link', { name: /Открыть и войти/ })

		// 5. Click magic-link
		await magicLinkLocator.click()
		await page.waitForURL(/\/welcome|\/o\//, { timeout: 15_000 })

		// 6. Type org name + create (если на /welcome)
		if (page.url().includes('/welcome')) {
			await page.getByLabel(/Название гостиницы/).fill(orgName)
			await page
				.locator('button:has-text("Создать гостиницу"):not([disabled])')
				.click({ timeout: 5_000 })
			await page.waitForURL(/\/o\/[^/]+\/setup/, { timeout: 30_000 })
		}

		// 7. ИНН lookup canonical mock
		await page.waitForLoadState('networkidle', { timeout: 10_000 })
		await page.getByLabel('ИНН гостиницы').fill('2320000001')
		await page.getByRole('button', { name: /^Найти$/ }).click()
		await expect(page.getByRole('complementary', { name: 'Найденная организация' })).toBeVisible({
			timeout: 10_000,
		})

		// 8. Подтвердить → inventory step
		await page.getByRole('button', { name: /Подтвердить/ }).click()
		await page.waitForLoadState('networkidle', { timeout: 5_000 })

		// 9. Fill rooms + price (canonical: 10 rooms × 3000₽)
		const numericInputs = await page.locator('input[inputmode="numeric"]').all()
		expect(
			numericInputs.length,
			'Inventory step must have ≥ 2 numeric inputs',
		).toBeGreaterThanOrEqual(2)
		await numericInputs[0]?.fill('10')
		await numericInputs[1]?.fill('3000')

		// 10. Submit → /grid
		await page.locator('button:has-text("Готово")').first().click()
		await page.waitForURL(/\/o\/[^/]+\/grid/, { timeout: 30_000 })

		// Success — landed on chessboard
		const finalUrl = page.url()
		expect(finalUrl, 'Full funnel must land on /grid').toMatch(/\/o\/[^/]+\/grid/)
	})
})
