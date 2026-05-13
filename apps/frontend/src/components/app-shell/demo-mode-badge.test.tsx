/**
 * DemoModeBadge — strict tests (A.bis.2 D31 / always-on demo strategy).
 *
 * Pre-done audit (per `feedback_strict_tests.md`):
 *   Mode rendering (enum FULL coverage):
 *     [B1] mode = undefined (loading)  → renders NULL (no flash, no SR noise)
 *     [B2] mode = 'demo'                → renders pill, data-mode="demo"
 *     [B3] mode = 'production'          → renders pill, data-mode="production"
 *
 *   RU label canon (D15 + plan §11):
 *     [L1] demo display text = «ДЕМО» (Cyrillic)
 *     [L2] demo aria-label   = «Демо-режим»
 *     [L3] production display text = «LIVE»
 *     [L4] production aria-label  = «Продакшн-режим»
 *
 *   a11y semantics (plan §12):
 *     [A1] role="status" present (live region announces mode flips)
 *     [A2] aria-live="polite" (non-disruptive)
 *
 *   Forced-colors mode (plan §16 C16):
 *     [F1] class includes `forced-colors:bg-[Highlight]`
 *     [F2] class includes `forced-colors:border-[ButtonText]`
 *
 *   Lookup table integrity:
 *     [T1] DEMO_MODE_BADGE_LABELS frozen
 *     [T2] DEMO_MODE_BADGE_LABELS has exactly 2 keys (TenantMode enum)
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { meQueryOptions } from '@/lib/use-can'
import { DemoModeBadge } from './demo-mode-badge'
import { DEMO_MODE_BADGE_LABELS } from './demo-mode-labels'

let queryClient: QueryClient

function seedMe(mode: 'demo' | 'production' | undefined) {
	if (mode === undefined) return
	queryClient.setQueryData(meQueryOptions.queryKey, {
		userId: 'usr-test',
		tenantId: 'org-test',
		role: 'owner',
		mode,
	})
}

function renderBadge() {
	return render(
		<QueryClientProvider client={queryClient}>
			<DemoModeBadge />
		</QueryClientProvider>,
	)
}

beforeEach(() => {
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
	})
})

afterEach(() => {
	cleanup()
	queryClient.clear()
})

/* -------------------------------------------------------------------------- */
/*  Mode rendering (enum FULL coverage)                                       */
/* -------------------------------------------------------------------------- */

describe('DemoModeBadge — mode rendering (enum FULL coverage)', () => {
	it('[B1] mode=undefined (loading) → renders NULL (no flash, no SR noise)', () => {
		// Don't seed — useQuery returns undefined data on first render.
		renderBadge()
		expect(document.querySelector('[data-slot="demo-mode-badge"]')).toBeNull()
	})

	it('[B2] mode=demo → renders pill with data-mode="demo"', () => {
		seedMe('demo')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill).not.toBeNull()
		expect(pill?.getAttribute('data-mode')).toBe('demo')
	})

	it('[B3] mode=production → renders pill with data-mode="production"', () => {
		seedMe('production')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill).not.toBeNull()
		expect(pill?.getAttribute('data-mode')).toBe('production')
	})
})

/* -------------------------------------------------------------------------- */
/*  RU label canon                                                            */
/* -------------------------------------------------------------------------- */

describe('DemoModeBadge — RU label canon (D15 + §11)', () => {
	it('[L1] demo display text = ДЕМО (Cyrillic)', () => {
		seedMe('demo')
		renderBadge()
		expect(screen.getByText('ДЕМО')).toBeDefined()
	})

	it('[L2] demo aria-label = Демо-режим', () => {
		seedMe('demo')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill?.getAttribute('aria-label')).toBe('Демо-режим')
	})

	it('[L3] production display text = LIVE', () => {
		seedMe('production')
		renderBadge()
		expect(screen.getByText('LIVE')).toBeDefined()
	})

	it('[L4] production aria-label = Продакшн-режим', () => {
		seedMe('production')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill?.getAttribute('aria-label')).toBe('Продакшн-режим')
	})
})

/* -------------------------------------------------------------------------- */
/*  a11y semantics                                                            */
/* -------------------------------------------------------------------------- */

describe('DemoModeBadge — a11y semantics (live region per §12)', () => {
	it('[A1] role="status" present', () => {
		seedMe('demo')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill?.getAttribute('role')).toBe('status')
	})

	it('[A2] aria-live="polite" (non-disruptive)', () => {
		seedMe('production')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill?.getAttribute('aria-live')).toBe('polite')
	})
})

/* -------------------------------------------------------------------------- */
/*  Forced-colors mode (Windows HCM)                                          */
/* -------------------------------------------------------------------------- */

describe('DemoModeBadge — forced-colors (HCM) borders', () => {
	it('[F1] class includes forced-colors:bg-[Highlight]', () => {
		seedMe('demo')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill?.getAttribute('class')).toContain('forced-colors:bg-[Highlight]')
	})

	it('[F2] class includes forced-colors:border-[ButtonText]', () => {
		seedMe('production')
		renderBadge()
		const pill = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(pill?.getAttribute('class')).toContain('forced-colors:border-[ButtonText]')
	})
})

/* -------------------------------------------------------------------------- */
/*  Lookup table integrity                                                    */
/* -------------------------------------------------------------------------- */

describe('DemoModeBadge — lookup table integrity', () => {
	it('[T1] DEMO_MODE_BADGE_LABELS frozen (Object.freeze canon)', () => {
		expect(Object.isFrozen(DEMO_MODE_BADGE_LABELS)).toBe(true)
	})

	it('[T2] DEMO_MODE_BADGE_LABELS has exactly 2 keys (TenantMode enum)', () => {
		const keys = Object.keys(DEMO_MODE_BADGE_LABELS).sort()
		expect(keys).toEqual(['demo', 'production'])
	})
})
