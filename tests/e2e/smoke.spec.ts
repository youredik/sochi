import { expect, test } from '@playwright/test'

/**
 * Post-deploy smoke — no DB writes, no storageState, runs against any
 * BASE_URL (staging / prod). Guards against "backend is up but wiring is
 * broken" regressions: /login renders, backend health is 200, Better Auth
 * get-session endpoint returns the expected null-session shape.
 */

test('anonymous /login renders', async ({ page }) => {
	await page.goto('/login')
	await expect(page.getByRole('heading', { name: /Вход/ })).toBeVisible()
})

test('backend /health is green', async ({ request }) => {
	const apiBase = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3000'
	const res = await request.get(`${apiBase}/health`)
	expect(res.status()).toBe(200)
	const body = await res.json()
	expect(body.status).toBe('ok')
})

test('get-session endpoint returns null for anonymous', async ({ request }) => {
	const apiBase = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3000'
	const res = await request.get(`${apiBase}/api/auth/get-session`)
	expect(res.status()).toBe(200)
	const body = await res.text()
	// Better Auth returns literal `null` for unauthenticated session calls.
	expect(body).toBe('null')
})
