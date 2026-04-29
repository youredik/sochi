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

const BASE_URL = 'http://localhost:5173'
const WIDGET_URL = `${BASE_URL}/widget/demo-sirius`
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
	console.log(`📷 Visual verify M9.widget.1 → ${WIDGET_URL}`)
	const browser = await chromium.launch()
	for (const view of VIEWS) {
		const context = await browser.newContext({
			viewport: view.viewport,
			colorScheme: view.theme,
		})
		const page = await context.newPage()
		// Set theme via localStorage + class (matches our M9.1 theme infra)
		await page.addInitScript((theme) => {
			localStorage.setItem('horeca-theme', theme)
			if (theme === 'dark') document.documentElement.classList.add('dark')
		}, view.theme)
		await page.goto(WIDGET_URL, { waitUntil: 'networkidle' })
		// Wait for h1 (means data loaded)
		await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 10_000 })
		const path = `${OUT_DIR}/widget-${view.name}.png`
		await page.screenshot({ path, fullPage: true })
		console.log(`  ✅ ${view.name}: ${path} (${view.viewport.width}×${view.viewport.height})`)
		await context.close()
	}
	await browser.close()
	console.log(`\n📁 4 screenshots saved to: ${OUT_DIR}/`)
	console.log('   Read them back via Read tool to verify visual quality.')
}

main().catch((err) => {
	console.error('❌ Visual verify failed:', err)
	process.exit(1)
})
