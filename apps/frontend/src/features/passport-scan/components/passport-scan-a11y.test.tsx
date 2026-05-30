/**
 * axe-core a11y unit tests для passport-scan UI (Sprint C Day 3).
 *
 * Использует `axe-core` standalone (4.11) в happy-dom через bun:test —
 * не Playwright. Fast unit-level a11y verification без overhead отдельного
 * e2e spec.
 *
 * Audit scope:
 *   - Consent152FzModal (3-checkbox + footer + scrollable text)
 *   - PassportScanDialog initial stage (file input + radio group)
 *
 * WCAG 2.2 AA tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa.
 */
import type { PassportEntities } from '@horeca/shared'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import axe from 'axe-core'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { Consent152FzModal } from './consent-152fz-modal.tsx'
import { ConfirmStage, PassportScanDialog } from './passport-scan-dialog.tsx'

afterEach(cleanup)

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function auditA11y(container: HTMLElement, context: string) {
	const results = await axe.run(container, {
		runOnly: { type: 'tag', values: WCAG_TAGS },
		// happy-dom limitations — disable rules that требуют real browser layout
		rules: {
			'color-contrast': { enabled: false }, // requires computed style (not happy-dom)
			'landmark-one-main': { enabled: false }, // dialog не должен иметь <main>
			region: { enabled: false }, // dialog content по дизайну не region
		},
	})
	if (results.violations.length > 0) {
		const formatted = results.violations.map((v) => ({
			id: v.id,
			impact: v.impact,
			help: v.help,
			nodes: v.nodes.map((n) => n.html),
		}))
		console.error(`axe violations (${context}):`, JSON.stringify(formatted, null, 2))
	}
	return results.violations
}

function renderWithQueryClient(ui: React.ReactNode) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('axe-core a11y — Consent152FzModal', () => {
	test('[A1] open modal с unchecked checkboxes → no WCAG 2.2 AA violations', async () => {
		const { container } = render(
			<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />,
		)
		const violations = await auditA11y(container, 'consent-modal-unchecked')
		expect(violations.length).toBe(0)
	})

	test('[A2] open modal с all 3 checkboxes checked → no violations', async () => {
		const { container } = render(
			<Consent152FzModal open={true} onAccept={mock()} onCancel={mock()} />,
		)
		// Programmatically check all 3 (Radix Checkbox patterns)
		const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
		for (const cb of checkboxes) {
			cb.click()
		}
		const violations = await auditA11y(container, 'consent-modal-all-checked')
		expect(violations.length).toBe(0)
	})
})

describe('axe-core a11y — PassportScanDialog', () => {
	test('[A3] initial stage (no scan yet) → no WCAG 2.2 AA violations', async () => {
		const { container } = renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const violations = await auditA11y(container, 'scan-dialog-initial')
		expect(violations.length).toBe(0)
	})
})

describe('axe-core a11y — ConfirmStage (amber per-field advisory)', () => {
	test('[A4] confirm stage с amber-слабыми полями → no WCAG 2.2 AA violations', async () => {
		// Слабые: фамилия (пусто), гражданство (пусто), номер (не РФ-формат) → amber.
		const entities: PassportEntities = {
			surname: null,
			name: 'Иван',
			middleName: null,
			gender: 'male',
			citizenshipIso3: null,
			birthDate: '1984-06-15',
			birthPlace: null,
			documentNumber: 'ЖЖЖ',
			issueDate: null,
			expirationDate: null,
		}
		const { container } = render(
			<ConfirmStage
				entities={entities}
				confidenceHeuristic={0.6}
				outcome="low_confidence"
				rklStatus="clean"
				identityMethod="passport_paper"
				onChange={mock()}
				validationError={null}
			/>,
		)
		const violations = await auditA11y(container, 'confirm-stage-amber')
		expect(violations.length).toBe(0)
	})
})
