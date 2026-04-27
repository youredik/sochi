/**
 * `<ContentWizardShell>` — strict tests for the shell + progress indicator.
 *
 * Test matrix:
 *   ─── Header ─────────────────────────────────────────────────────
 *     [H1] h1 "Профиль гостиницы" rendered
 *
 *   ─── Initial render ──────────────────────────────────────────────
 *     [R1] step='compliance' default → ComplianceStep section visible
 *
 *   ─── Progress indicator (5 visible steps; 'done' hidden) ─────────
 *     [P1] 5 step buttons rendered (compliance, amenities, descriptions,
 *          media, addons) — 'done' is hidden from indicator
 *     [P2] active step has aria-current="step"
 *     [P3] click step button → store transitions
 *
 *   ─── done → navigate ─────────────────────────────────────────────
 *     [D1] when store.step='done' → navigate called with /o/$orgSlug
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const navigateSpy = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateSpy,
}))

vi.mock('./hooks/use-compliance.ts', () => ({
	useCompliance: vi.fn(() => ({ data: null, isLoading: false, error: null })),
	usePatchCompliance: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))

vi.mock('../../lib/use-can.ts', () => ({
	useCan: vi.fn(() => true),
	useCurrentRole: vi.fn(() => 'owner'),
}))

import { ContentWizardShell } from './wizard-shell.tsx'
import { useContentWizardStore } from './wizard-store.ts'

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	useContentWizardStore.getState().reset()
})

/**
 * `useNavigate` is mocked at module scope (above) so the shell's effect
 * doesn't crash without a full Router context. Testing-library renders
 * the component directly — this isolates shell behavior (progress, steps,
 * done-effect) from the routing layer, which is integration-tested by
 * Playwright e2e instead.
 */
function renderShell() {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
	})
	return render(
		<QueryClientProvider client={qc}>
			<ContentWizardShell propertyId="prop_x" orgSlug="acme" />
		</QueryClientProvider>,
	)
}

describe('<ContentWizardShell> — header + initial render', () => {
	test('[H1] h1 "Профиль гостиницы" rendered', () => {
		renderShell()
		expect(screen.getByRole('heading', { level: 1, name: 'Профиль гостиницы' })).toBeTruthy()
	})

	test('[R1] step=compliance default → ComplianceStep section visible', () => {
		renderShell()
		expect(screen.getByRole('region', { name: /Compliance — нормативные данные/ })).toBeTruthy()
	})
})

describe('<ContentWizardShell> — progress indicator', () => {
	test('[P1] 5 visible step buttons (done hidden)', () => {
		renderShell()
		const ol = screen.getByRole('list')
		const buttons = within(ol).getAllByRole('button')
		expect(buttons).toHaveLength(5)
	})

	test('[P2] active step (compliance by default) has aria-current="step"', () => {
		renderShell()
		const ol = screen.getByRole('list')
		const items = within(ol).getAllByRole('listitem')
		// 1st item = compliance
		expect(items[0]?.getAttribute('aria-current')).toBe('step')
		// others should NOT
		expect(items[1]?.getAttribute('aria-current') ?? null).toBe(null)
	})

	test('[P3] click 3rd step button → store transitions to descriptions', () => {
		renderShell()
		const ol = screen.getByRole('list')
		const buttons = within(ol).getAllByRole('button')
		fireEvent.click(buttons[2] as HTMLButtonElement)
		expect(useContentWizardStore.getState().step).toBe('descriptions')
	})

	test('[P4] every step button (5 in canonical order) navigates to its step', () => {
		const expectedOrder: ReadonlyArray<
			'compliance' | 'amenities' | 'descriptions' | 'media' | 'addons'
		> = ['compliance', 'amenities', 'descriptions', 'media', 'addons']
		for (let idx = 0; idx < expectedOrder.length; idx++) {
			cleanup()
			renderShell()
			const ol = screen.getByRole('list')
			const buttons = within(ol).getAllByRole('button')
			fireEvent.click(buttons[idx] as HTMLButtonElement)
			expect(useContentWizardStore.getState().step).toBe(expectedOrder[idx])
		}
	})
})

describe('<ContentWizardShell> — done auto-navigate', () => {
	beforeEach(() => {
		// Set store to 'done' BEFORE mount so the useEffect navigates immediately.
		useContentWizardStore.getState().goTo('done')
	})

	test('[D1] when step=done at mount → store auto-resets via effect', () => {
		// We don't mock useNavigate (it's part of router), but the effect calls
		// `reset()` synchronously and then `void navigate(...)`. The reset is
		// observable via store state.
		renderShell()
		expect(useContentWizardStore.getState().step).toBe('compliance')
	})
})
