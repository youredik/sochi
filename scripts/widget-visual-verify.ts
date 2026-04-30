/**
 * One-shot visual smoke for M9.widget.1 — takes screenshots в 4 viewports
 * и сохраняет в /tmp/widget-screenshots/ для honest visual verification.
 *
 * Per system prompt canon: «For UI or frontend changes, start the dev
 * server and use the feature in a browser before reporting the task as
 * complete». Не должна быть в e2e gate — это разовая проверка.
 *
 * Запуск (после `pnpm dev` в фоне):
 *   node --env-file-if-exists=.env scripts/widget-visual-verify.ts
 */
import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE_URL = 'http://localhost:5273'
const WIDGET_URL = `${BASE_URL}/widget/demo-sirius`
const todayPlus = (days: number) => {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + days)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
const SCREEN1_URL = `${BASE_URL}/widget/demo-sirius/demo-prop-sirius-main?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`
const OUT_DIR = '/tmp/widget-screenshots'

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

interface ViewSpec {
	readonly name: string
	readonly viewport: { width: number; height: number }
	readonly theme: 'light' | 'dark'
}

const VIEWS: ViewSpec[] = [
	{ name: 'desktop-light', viewport: { width: 1280, height: 800 }, theme: 'light' },
	{ name: 'desktop-dark', viewport: { width: 1280, height: 800 }, theme: 'dark' },
	{ name: 'mobile-light', viewport: { width: 360, height: 740 }, theme: 'light' },
	{ name: 'mobile-dark', viewport: { width: 360, height: 740 }, theme: 'dark' },
]

async function main(): Promise<void> {
	console.log(`📷 Visual verify M9.widget.1 + M9.widget.2 → ${WIDGET_URL}`)
	const browser = await chromium.launch()
	// Property list (M9.widget.1)
	for (const view of VIEWS) {
		const context = await browser.newContext({
			viewport: view.viewport,
			colorScheme: view.theme,
		})
		const page = await context.newPage()
		await page.addInitScript((theme) => {
			localStorage.setItem('horeca-theme', theme)
			if (theme === 'dark') document.documentElement.classList.add('dark')
		}, view.theme)
		await page.goto(WIDGET_URL, { waitUntil: 'networkidle' })
		await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 10_000 })
		const path = `${OUT_DIR}/widget-list-${view.name}.png`
		await page.screenshot({ path, fullPage: true })
		console.log(`  ✅ list-${view.name}: ${path} (${view.viewport.width}×${view.viewport.height})`)
		await context.close()
	}
	// Screen 1 Search & Pick (M9.widget.2)
	console.log('\n📷 Screen 1 Search & Pick verify')
	for (const view of VIEWS) {
		const context = await browser.newContext({
			viewport: view.viewport,
			colorScheme: view.theme,
		})
		const page = await context.newPage()
		await page.addInitScript((theme) => {
			localStorage.setItem('horeca-theme', theme)
			if (theme === 'dark') document.documentElement.classList.add('dark')
		}, view.theme)
		await page.goto(SCREEN1_URL, { waitUntil: 'networkidle' })
		await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 10_000 })
		const path = `${OUT_DIR}/widget-screen1-${view.name}.png`
		await page.screenshot({ path, fullPage: true })
		console.log(`  ✅ screen1-${view.name}: ${path} (${view.viewport.width}×${view.viewport.height})`)
		await context.close()
	}
	// Not-found state
	console.log('\n📷 Not-found state verify')
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		colorScheme: 'light',
	})
	const page = await ctx.newPage()
	await page.goto(`${BASE_URL}/widget/never-exists-12345`, { waitUntil: 'networkidle' })
	await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 10_000 })
	const nfPath = `${OUT_DIR}/widget-not-found.png`
	await page.screenshot({ path: nfPath, fullPage: true })
	console.log(`  ✅ not-found: ${nfPath}`)
	await ctx.close()
	await browser.close()
	console.log(`\n📁 9 screenshots saved to: ${OUT_DIR}/`)
	console.log('   Read them back via Read tool to verify visual quality.')
}

main().catch((err) => {
	console.error('❌ Visual verify failed:', err)
	process.exit(1)
})
