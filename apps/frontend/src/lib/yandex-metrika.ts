/**
 * Yandex.Metrika integration — counter 109307396 (created 2026-05-19).
 *
 * Architecture:
 *   - `initYandexMetrika(counterId)` — sync init, idempotent. Counter ID
 *     передаётся как параметр (не читается из env внутри) → testability.
 *   - `initYandexMetrikaDeferred(counterId)` — defer до first user
 *     interaction (scroll/click/keydown) OR requestIdleCallback timeout
 *     5s. Per `project_landing_research_2026_05_19` — LCP boost: не
 *     блокируем initial render параллельной загрузкой analytics-tag.
 *   - `trackPageView(url)` — SPA navigation hit (called from
 *     TanStack Router `subscribe('onResolved')`).
 *   - `reachGoal(name)` — explicit goal для landing button clicks
 *     ('tg_click', 'email_click'). mailto: links не покрываются
 *     `trackLinks: true` auto-tracking.
 *   - `__resetForTesting()` — clears module-state per
 *     `feedback_bun_test_canons_2026_05_13` §2 (bun:test НЕ auto-resets
 *     modules между tests).
 *
 * Browser API:
 *   - `document.createElement('script')` — load `mc.yandex.ru/metrika/tag_ww.js`
 *   - `window.ym` — Yandex global command-queue function
 *   - `requestIdleCallback` (с setTimeout fallback) для defer
 *   - `addEventListener` с `{ once: true }` для first-interaction trigger
 *
 * No-op paths:
 *   - counterId === undefined OR NaN
 *   - `typeof window === 'undefined'` (SSR / test bez happy-dom)
 */

type YmCallable = ((...args: unknown[]) => void) & { a?: unknown[][]; l?: number }

declare global {
	// eslint-disable-next-line no-var
	interface Window {
		ym?: YmCallable
	}
}

/**
 * Module-level state — single counter ID per app lifetime. Tests must call
 * `__resetForTesting()` в `beforeEach`/`afterEach` чтобы reset (bun:test
 * canon).
 */
let activeCounterId: number | undefined

const TAG_SCRIPT_URL = 'https://mc.yandex.ru/metrika/tag_ww.js'
const TAG_SCRIPT_SELECTOR = `script[src*="mc.yandex.ru/metrika"]`

function isValidCounterId(id: number | undefined): id is number {
	return id !== undefined && Number.isFinite(id) && id > 0
}

/**
 * Test-only state reset.
 *
 * Per `feedback_bun_test_canons_2026_05_13` §2 — bun:test doesn't
 * auto-reset module state between tests. Tests MUST call this в
 * `beforeEach` ИЛИ `afterEach` чтобы избежать cross-test pollution.
 *
 * Removes window.ym, all injected script elements, и сбрасывает
 * `activeCounterId`. Naming `__` prefix signals «internal, no
 * external dependants».
 */
export function __resetForTesting(): void {
	activeCounterId = undefined
	if (typeof window === 'undefined') return
	const win = window as Window & { ym?: YmCallable }
	if ('ym' in win) {
		delete win.ym
	}
	const scripts = document.querySelectorAll(TAG_SCRIPT_SELECTOR)
	for (const s of scripts) {
		s.remove()
	}
}

/**
 * Synchronously initialize Yandex.Metrika. Idempotent: вторая call —
 * no-op (window.ym already defined).
 */
export function initYandexMetrika(counterId: number | undefined): void {
	if (!isValidCounterId(counterId)) return
	if (typeof window === 'undefined') return
	if (window.ym !== undefined) return

	// Canonical Y.Metrika async loader pattern simplified to ESM. Queue
	// pushed via `ym(...)` is drained by tag_ww.js когда оно loads.
	const queue: unknown[][] = []
	const ym: YmCallable = function ym(...args: unknown[]) {
		queue.push(args)
	}
	ym.a = queue
	ym.l = Date.now()
	window.ym = ym

	const script = document.createElement('script')
	script.src = TAG_SCRIPT_URL
	script.async = true
	document.head.appendChild(script)

	window.ym(counterId, 'init', {
		ssr: true,
		webvisor: true,
		clickmap: true,
		accurateTrackBounce: true,
		trackLinks: true,
	})

	activeCounterId = counterId
}

/**
 * Defer init до first user interaction (scroll/click/keydown) OR
 * `requestIdleCallback` timeout 5s — LCP optimization.
 *
 * Идея: tag_ww.js load (~40 KiB external) + execution блокируют
 * нагрузку CPU в момент когда browser должен render'ить first-contentful
 * frame. Defer переносит к моменту когда user уже видит landing.
 *
 * 4 триггера, whichever fires first:
 *   1. `scroll` event (passive, once)
 *   2. `click` event (once)
 *   3. `keydown` event (once)
 *   4. `requestIdleCallback({timeout: 5000})` — guaranteed maximum 5s
 *      latency
 */
export function initYandexMetrikaDeferred(counterId: number | undefined): void {
	if (!isValidCounterId(counterId)) return
	if (typeof window === 'undefined') return

	let triggered = false
	function trigger(): void {
		if (triggered) return
		triggered = true
		cleanup()
		initYandexMetrika(counterId)
	}
	function cleanup(): void {
		document.removeEventListener('scroll', trigger)
		document.removeEventListener('click', trigger)
		document.removeEventListener('keydown', trigger)
	}

	document.addEventListener('scroll', trigger, { once: true, passive: true })
	document.addEventListener('click', trigger, { once: true })
	document.addEventListener('keydown', trigger, { once: true })

	type IdleCallback = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void
	type WindowWithRIC = Window & {
		requestIdleCallback?: (cb: IdleCallback, opts?: { timeout: number }) => number
	}
	const w = window as WindowWithRIC
	if (typeof w.requestIdleCallback === 'function') {
		w.requestIdleCallback(trigger, { timeout: 5000 })
	} else {
		// happy-dom + старые browsers — fallback на setTimeout
		setTimeout(trigger, 5000)
	}
}

/**
 * Track SPA navigation hit. No-op без активного counter (init не вызван
 * или counterId был invalid).
 */
export function trackPageView(url: string): void {
	if (activeCounterId === undefined) return
	if (typeof window === 'undefined' || window.ym === undefined) return
	window.ym(activeCounterId, 'hit', url)
}

/**
 * Track explicit goal. Используется для CTA-кликов на landing'е (mailto:
 * не покрывается `trackLinks: true` auto-tracking). No-op без активного
 * counter.
 */
export function reachGoal(name: string): void {
	if (activeCounterId === undefined) return
	if (typeof window === 'undefined' || window.ym === undefined) return
	window.ym(activeCounterId, 'reachGoal', name)
}
