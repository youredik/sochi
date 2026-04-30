/**
 * Visual smoke — captures 4 viewports of Extras screen for senior-pass review.
 *
 * Per `project_m9_widget_2_done.md` process correction: «Read screenshots BEFORE
 * "done"» canon. Run after `pnpm dev` started backend + frontend.
 *
 * Usage: node --env-file-if-exists=.env scripts/visual-smoke-extras.ts
 *
 * Outputs to `.artifacts/m9_widget_3/`:
 *   01-extras-light-desktop.png   (1440×900)
 *   02-extras-dark-desktop.png    (1440×900)
 *   03-extras-mobile.png          (390×844 — iPhone 14)
 *   04-extras-forced-colors.png   (1440×900)
 */

import { mkdir } from 'node:fs/promises'
import { chromium, type Browser, type Page } from '@playwright/test'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const OUT_DIR = '.artifacts/m9_widget_3'

function buildUrl(): string {
	const today = new Date()
	today.setUTCDate(today.getUTCDate() + 30)
	const ci = today.toISOString().slice(0, 10)
	const co = new Date(today.getTime() + 3 * 86_400_000).toISOString().slice(0, 10)
	const params = new URLSearchParams({
		checkIn: ci,
		checkOut: co,
		adults: '2',
		children: '0',
		roomTypeId: 'demo-roomtype-deluxe',
		ratePlanId: 'demo-rateplan-deluxe-bar-flex',
	})
	return `${BASE}/widget/demo-sirius/demo-prop-sirius-main/extras?${params.toString()}`
}

async function shoot(page: Page, name: string) {
	await page.waitForSelector('[data-testid="addon-card-BREAKFAST"]', { timeout: 10_000 })
	await page.waitForTimeout(300) // settle animations
	const path = `${OUT_DIR}/${name}.png`
	await page.screenshot({ path, fullPage: true })
	console.log(`  → ${path}`)
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true })
	const url = buildUrl()
	console.log(`Visual smoke target: ${url}\n`)

	const browser: Browser = await chromium.launch()
	try {
		// 1. Light + desktop
		console.log('[1/4] light + desktop 1440×900')
		{
			const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
			const page = await ctx.newPage()
			await page.goto(url)
			await shoot(page, '01-extras-light-desktop')
			await ctx.close()
		}

		// 2. Dark + desktop
		console.log('[2/4] dark + desktop 1440×900')
		{
			const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
			const page = await ctx.newPage()
			await page.addInitScript(() => {
				document.documentElement.classList.add('dark')
				localStorage.setItem('horeca-theme', 'dark')
			})
			await page.goto(url)
			await shoot(page, '02-extras-dark-desktop')
			await ctx.close()
		}

		// 3. Mobile 390×844 (iPhone 14)
		console.log('[3/4] mobile 390×844')
		{
			const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
			const page = await ctx.newPage()
			await page.goto(url)
			await shoot(page, '03-extras-mobile')
			await ctx.close()
		}

		// 4. Forced-colors mode
		console.log('[4/4] forced-colors + desktop 1440×900')
		{
			const ctx = await browser.newContext({
				viewport: { width: 1440, height: 900 },
				forcedColors: 'active',
			})
			const page = await ctx.newPage()
			await page.goto(url)
			await shoot(page, '04-extras-forced-colors')
			await ctx.close()
		}

		console.log('\n✅ Visual smoke complete. Outputs in .artifacts/m9_widget_3/')
	} finally {
		await browser.close()
	}
}

void main().catch((err) => {
	console.error('❌ Visual smoke failed:', err)
	process.exit(1)
})
