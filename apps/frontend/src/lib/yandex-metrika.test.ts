/**
 * `yandex-metrika.ts` — strict tests per `feedback_strict_tests.md` +
 * `feedback_bun_test_canons_2026_05_13` §2 (module-state reset).
 *
 * Invariants under test:
 *   - I1 No-op без valid counterId (undefined / NaN / ≤0 / Infinity)
 *   - I2 Idempotency: 2nd init после 1st = no-op (script не дублируется,
 *        window.ym preserved)
 *   - I3 Init creates: window.ym function + <script async> + 'init' queue
 *        entry с EXACT options shape
 *   - I4 trackPageView / reachGoal no-op без активного counter; correct
 *        EXACT args post-init
 *   - I5 `__resetForTesting()` clears window.ym + scripts + activeCounterId
 *        → re-init works
 *   - I6 Deferred init НЕ fires immediately; fires on first user interaction
 *        (click/scroll/keydown); no-op без counter
 *
 * No `toBeDefined`/`toBeTruthy`/`toBeFalsy`/`toBeInstanceOf(Array)` —
 * weak_assertions=0 ratchet. No `.not.toBeUndefined()` — equally weak
 * (matches любое non-undefined). Use `typeof x === 'function'` or
 * `.toBe(expected)` exact.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
	__resetForTesting,
	initYandexMetrika,
	initYandexMetrikaDeferred,
	reachGoal,
	trackPageView,
} from './yandex-metrika.ts'

const VALID_ID = 109307396

interface YmAccess {
	ym?: ((...args: unknown[]) => void) & { a?: unknown[][]; l?: number }
}

function getYm(): YmAccess['ym'] {
	return (window as Window & YmAccess).ym
}

function getScripts(): NodeListOf<HTMLScriptElement> {
	return document.querySelectorAll<HTMLScriptElement>('script[src*="mc.yandex.ru/metrika"]')
}

beforeEach(() => {
	__resetForTesting()
})

afterEach(() => {
	__resetForTesting()
})

describe('yandex-metrika lib', () => {
	describe('initYandexMetrika() — I1 no-op paths', () => {
		test('[YM01] undefined counter → no DOM, no ym', () => {
			initYandexMetrika(undefined)
			expect(getScripts().length).toBe(0)
			expect(typeof getYm()).toBe('undefined')
		})

		test('[YM02] NaN counter → no DOM, no ym', () => {
			initYandexMetrika(Number.NaN)
			expect(getScripts().length).toBe(0)
			expect(typeof getYm()).toBe('undefined')
		})

		test('[YM03] zero counter → no DOM (positive int requirement)', () => {
			initYandexMetrika(0)
			expect(getScripts().length).toBe(0)
		})

		test('[YM04] negative counter → no DOM', () => {
			initYandexMetrika(-1)
			expect(getScripts().length).toBe(0)
		})

		test('[YM05] Infinity counter → no DOM', () => {
			initYandexMetrika(Number.POSITIVE_INFINITY)
			expect(getScripts().length).toBe(0)
		})
	})

	describe('initYandexMetrika() — I3 happy path', () => {
		test('[YM06] valid counter → script element appended (async=true)', () => {
			initYandexMetrika(VALID_ID)
			const scripts = getScripts()
			expect(scripts.length).toBe(1)
			expect(scripts[0]?.async).toBe(true)
			expect(scripts[0]?.src).toBe('https://mc.yandex.ru/metrika/tag_ww.js')
		})

		test('[YM07] valid counter → window.ym defined as function', () => {
			initYandexMetrika(VALID_ID)
			expect(typeof getYm()).toBe('function')
		})

		test('[YM08] init enqueues call with EXACT options shape', () => {
			initYandexMetrika(VALID_ID)
			const ym = getYm()
			expect(ym?.a?.length).toBe(1)
			expect(ym?.a?.[0]).toEqual([
				VALID_ID,
				'init',
				{
					ssr: true,
					webvisor: true,
					clickmap: true,
					accurateTrackBounce: true,
					trackLinks: true,
				},
			])
		})

		test('[YM09] ym.l timestamp set (drainage marker)', () => {
			const before = Date.now()
			initYandexMetrika(VALID_ID)
			const after = Date.now()
			const l = getYm()?.l
			expect(typeof l).toBe('number')
			expect(l).toBeGreaterThanOrEqual(before)
			expect(l).toBeLessThanOrEqual(after)
		})
	})

	describe('initYandexMetrika() — I2 idempotency', () => {
		test('[YM10] 2nd init does not duplicate script', () => {
			initYandexMetrika(VALID_ID)
			initYandexMetrika(VALID_ID)
			expect(getScripts().length).toBe(1)
		})

		test('[YM11] 2nd init does not replace ym reference', () => {
			initYandexMetrika(VALID_ID)
			const ymFirst = getYm()
			initYandexMetrika(VALID_ID)
			const ymSecond = getYm()
			expect(ymSecond).toBe(ymFirst)
		})

		test('[YM12] 2nd init does not re-enqueue init call', () => {
			initYandexMetrika(VALID_ID)
			initYandexMetrika(VALID_ID)
			expect(getYm()?.a?.length).toBe(1)
		})

		test('[YM13] adversarial: different counterId on 2nd call — STILL no-op', () => {
			// первый init wins; subsequent attempts с другим counterId не
			// должны переопределять (это explicit canon — defensive).
			initYandexMetrika(VALID_ID)
			initYandexMetrika(99999)
			expect(getScripts().length).toBe(1)
			expect(getYm()?.a?.[0]).toEqual([
				VALID_ID,
				'init',
				{
					ssr: true,
					webvisor: true,
					clickmap: true,
					accurateTrackBounce: true,
					trackLinks: true,
				},
			])
		})
	})

	describe('trackPageView() — I4', () => {
		test('[TPV01] before init → no-op (no ym defined)', () => {
			trackPageView('/test-path')
			expect(typeof getYm()).toBe('undefined')
		})

		test('[TPV02] after init → ym enqueued with hit + exact url', () => {
			initYandexMetrika(VALID_ID)
			trackPageView('/o/some-org/grid')
			const ym = getYm()
			expect(ym?.a?.length).toBe(2)
			expect(ym?.a?.[1]).toEqual([VALID_ID, 'hit', '/o/some-org/grid'])
		})

		test('[TPV03] empty url passes through (caller validates)', () => {
			initYandexMetrika(VALID_ID)
			trackPageView('')
			expect(getYm()?.a?.[1]).toEqual([VALID_ID, 'hit', ''])
		})
	})

	describe('reachGoal() — I4', () => {
		test('[RG01] before init → no-op', () => {
			reachGoal('tg_click')
			expect(typeof getYm()).toBe('undefined')
		})

		test('[RG02] after init → ym enqueued with reachGoal + exact name', () => {
			initYandexMetrika(VALID_ID)
			reachGoal('email_click')
			const ym = getYm()
			expect(ym?.a?.length).toBe(2)
			expect(ym?.a?.[1]).toEqual([VALID_ID, 'reachGoal', 'email_click'])
		})
	})

	describe('__resetForTesting() — I5', () => {
		test('[RST01] removes window.ym after init', () => {
			initYandexMetrika(VALID_ID)
			expect(typeof getYm()).toBe('function')
			__resetForTesting()
			expect(typeof getYm()).toBe('undefined')
		})

		test('[RST02] removes injected scripts', () => {
			initYandexMetrika(VALID_ID)
			expect(getScripts().length).toBe(1)
			__resetForTesting()
			expect(getScripts().length).toBe(0)
		})

		test('[RST03] re-init after reset succeeds (fresh state)', () => {
			initYandexMetrika(VALID_ID)
			__resetForTesting()
			initYandexMetrika(VALID_ID)
			expect(getScripts().length).toBe(1)
			expect(typeof getYm()).toBe('function')
		})

		test('[RST04] trackPageView is no-op after reset', () => {
			initYandexMetrika(VALID_ID)
			__resetForTesting()
			trackPageView('/anywhere')
			expect(typeof getYm()).toBe('undefined')
		})
	})

	describe('initYandexMetrikaDeferred() — I6', () => {
		test('[DEF01] does NOT init immediately', () => {
			initYandexMetrikaDeferred(VALID_ID)
			expect(typeof getYm()).toBe('undefined')
			expect(getScripts().length).toBe(0)
		})

		test('[DEF02] click event triggers init', () => {
			initYandexMetrikaDeferred(VALID_ID)
			document.dispatchEvent(new Event('click'))
			expect(typeof getYm()).toBe('function')
			expect(getScripts().length).toBe(1)
		})

		test('[DEF03] scroll event triggers init', () => {
			initYandexMetrikaDeferred(VALID_ID)
			document.dispatchEvent(new Event('scroll'))
			expect(typeof getYm()).toBe('function')
		})

		test('[DEF04] keydown event triggers init', () => {
			initYandexMetrikaDeferred(VALID_ID)
			document.dispatchEvent(new Event('keydown'))
			expect(typeof getYm()).toBe('function')
		})

		test('[DEF05] 2 events → init fires once (idempotency)', () => {
			initYandexMetrikaDeferred(VALID_ID)
			document.dispatchEvent(new Event('click'))
			document.dispatchEvent(new Event('scroll'))
			expect(getScripts().length).toBe(1)
		})

		test('[DEF06] no counter → no listeners attached (click no-op)', () => {
			initYandexMetrikaDeferred(undefined)
			document.dispatchEvent(new Event('click'))
			expect(typeof getYm()).toBe('undefined')
		})

		test('[DEF07] NaN counter → no listeners attached', () => {
			initYandexMetrikaDeferred(Number.NaN)
			document.dispatchEvent(new Event('click'))
			expect(typeof getYm()).toBe('undefined')
		})
	})
})
