/**
 * INTERACTIVE user-journey verify для M9.widget.2 — эмулирует живого
 * пользователя на mobile + desktop, делает clicks во все UI elements
 * и captures screenshot каждого state.
 *
 * Per system-prompt canon: «start the dev server и use the feature in a
 * browser before reporting the task as complete». Static screenshots
 * verify layout; this verifies INTERACTION (click, hover, keyboard).
 *
 * Запуск (с pnpm dev в фоне):
 *   node --env-file-if-exists=.env scripts/widget-interactive-verify.ts
 */
import { existsSync, mkdirSync } from 'node:fs'
import { chromium } from '@playwright/test'

const BASE_URL = 'http://localhost:5273'
const OUT_DIR = '/tmp/widget-interactive'

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })

const todayPlus = (days: number) => {
	const d = new Date()
	d.setUTCHours(0, 0, 0, 0)
	d.setUTCDate(d.getUTCDate() + days)
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

const SCREEN1_URL = `${BASE_URL}/widget/demo-sirius/demo-prop-sirius-main?checkIn=${todayPlus(30)}&checkOut=${todayPlus(33)}&adults=2&children=0`

async function main(): Promise<void> {
	const browser = await chromium.launch()

	// ─── DESKTOP user-journey ──────────────────────────────────────
	console.log('🖥  Desktop user-journey (1280×800)')
	const desktopCtx = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		colorScheme: 'light',
	})
	const desktop = await desktopCtx.newPage()
	await desktop.goto(SCREEN1_URL, { waitUntil: 'networkidle' })
	await desktop.getByRole('heading', { level: 1 }).waitFor()
	await desktop.getByTestId('summary-total-detail').first().waitFor()

	// 1. Initial state with default rate selected
	await desktop.screenshot({ path: `${OUT_DIR}/desktop-1-initial.png`, fullPage: true })
	console.log('  ✅ 1-initial')

	// 2. Open date picker — Popover renders Calendar
	await desktop.getByRole('button', { name: /Выбрать даты заезда/ }).click()
	await desktop.waitForTimeout(300) // animation
	await desktop.screenshot({ path: `${OUT_DIR}/desktop-2-datepicker-open.png`, fullPage: false })
	console.log('  ✅ 2-datepicker-open')
	// close
	await desktop.keyboard.press('Escape')
	await desktop.waitForTimeout(200)

	// 3. Open guest selector
	await desktop.getByRole('button', { name: /Выбрать количество гостей/ }).click()
	await desktop.waitForTimeout(300)
	await desktop.screenshot({ path: `${OUT_DIR}/desktop-3-guests-open.png`, fullPage: false })
	console.log('  ✅ 3-guests-open')

	// 4. Click children plus → see stepper reactivity. Demo property maxOccupancy=2, so
	// 2+1=3 total → API returns 0 offerings (correct business rule). Screenshot shows
	// the «no rooms matching» empty-state message, proving filter works end-to-end.
	await desktop.getByTestId('guests-children-plus').click()
	await desktop.waitForTimeout(500)
	await desktop.screenshot({ path: `${OUT_DIR}/desktop-4-guests-+1-child.png`, fullPage: true })
	console.log('  ✅ 4-guests-+1-child (stepper + occupancy filter)')
	// close popover (clicks outside)
	await desktop.locator('h1').click({ force: true })
	await desktop.waitForTimeout(300)

	// 5. Reload с default 2 adults to test rate switch
	await desktop.goto(SCREEN1_URL, { waitUntil: 'networkidle' })
	await desktop.getByTestId('summary-total-detail').first().waitFor()

	// 6. Switch rate plan: click BAR_NR (Невозвратный) on Deluxe
	await desktop
		.locator('[data-testid="rate-card-demo-roomtype-deluxe"] [data-testid="rate-option-BAR_NR"]')
		.click()
	await desktop.waitForTimeout(200)
	await desktop.screenshot({ path: `${OUT_DIR}/desktop-5-bar-nr-selected.png`, fullPage: true })
	console.log('  ✅ 5-bar-nr-selected (rate switch updates summary)')

	// 6. Switch room: click Standard rate
	await desktop
		.locator(
			'[data-testid="rate-card-demo-roomtype-standard"] [data-testid="rate-option-BAR_FLEX"]',
		)
		.click()
	await desktop.waitForTimeout(200)
	await desktop.screenshot({ path: `${OUT_DIR}/desktop-6-standard-flex.png`, fullPage: true })
	console.log('  ✅ 6-standard-flex (room switch)')

	await desktopCtx.close()

	// ─── MOBILE user-journey ──────────────────────────────────────
	console.log('\n📱 Mobile user-journey (360×740)')
	const mobileCtx = await browser.newContext({
		viewport: { width: 360, height: 740 },
		colorScheme: 'light',
		isMobile: true,
		hasTouch: true,
	})
	const mobile = await mobileCtx.newPage()
	await mobile.goto(SCREEN1_URL, { waitUntil: 'networkidle' })
	await mobile.getByRole('heading', { level: 1 }).waitFor()
	await mobile.getByTestId('summary-total').first().waitFor()

	// 1. Initial state — bottom Vaul peek bar visible
	await mobile.screenshot({ path: `${OUT_DIR}/mobile-1-initial.png`, fullPage: true })
	console.log('  ✅ 1-initial (Vaul peek bar bottom)')

	// 2. Tap peek bar to expand Vaul drawer
	await mobile.getByTestId('summary-peek-trigger').click()
	await mobile.waitForTimeout(500) // drawer animation
	await mobile.screenshot({ path: `${OUT_DIR}/mobile-2-vaul-expanded.png`, fullPage: false })
	console.log('  ✅ 2-vaul-expanded (full breakdown drawer)')

	// 3. Close drawer
	await mobile.keyboard.press('Escape')
	await mobile.waitForTimeout(300)

	// 4. Open date picker (single-month mobile per useMediaQuery)
	await mobile.getByRole('button', { name: /Выбрать даты заезда/ }).click()
	await mobile.waitForTimeout(300)
	await mobile.screenshot({ path: `${OUT_DIR}/mobile-3-datepicker.png`, fullPage: false })
	console.log('  ✅ 3-datepicker (single-month mobile)')
	await mobile.keyboard.press('Escape')

	// 5. Switch rate to NR
	await mobile.getByTestId('rate-option-BAR_NR').first().click()
	await mobile.waitForTimeout(200)
	await mobile.screenshot({ path: `${OUT_DIR}/mobile-4-rate-switch.png`, fullPage: true })
	console.log('  ✅ 4-rate-switch (peek bar updates total)')

	// 6. Hover-equivalent: focus on rate card to see focus-visible outline
	await mobile.getByTestId('rate-option-BAR_FLEX').first().focus()
	await mobile.screenshot({ path: `${OUT_DIR}/mobile-5-focus-visible.png`, fullPage: false })
	console.log('  ✅ 5-focus-visible (a11y outline)')

	await mobileCtx.close()

	// ─── DARK MODE smoke ──────────────────────────────────────────
	console.log('\n🌙 Dark mode interactive smoke')
	const darkCtx = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		colorScheme: 'dark',
	})
	const dark = await darkCtx.newPage()
	await dark.addInitScript(() => {
		localStorage.setItem('horeca-theme', 'dark')
		document.documentElement.classList.add('dark')
	})
	await dark.goto(SCREEN1_URL, { waitUntil: 'networkidle' })
	await dark.getByRole('heading', { level: 1 }).waitFor()
	await dark.screenshot({ path: `${OUT_DIR}/dark-1-initial.png`, fullPage: true })
	console.log('  ✅ dark-1-initial')
	// Date picker open in dark
	await dark.getByRole('button', { name: /Выбрать даты заезда/ }).click()
	await dark.waitForTimeout(300)
	await dark.screenshot({ path: `${OUT_DIR}/dark-2-datepicker.png`, fullPage: false })
	console.log('  ✅ dark-2-datepicker')

	await darkCtx.close()
	await browser.close()
	console.log(
		`\n📁 Saved to: ${OUT_DIR}/\n   Read screenshots back via Read tool to verify quality.`,
	)
}

main().catch((err) => {
	console.error('❌ Interactive verify failed:', err)
	process.exit(1)
})
