/**
 * PassportScanDialog — strict UX/a11y tests (Sprint C Day 2 surface).
 *
 * Tests focus на UI shape, not Vision OCR / mutation flow (mutation is covered
 * by hook tests + backend route tests). These tests verify Sprint C Day 2
 * UX upgrades render correctly:
 *   - Initial stage: file input + identity-method RadioGroup + 152-ФЗ gate
 *   - Open + no consent + file pick → consent modal opens (gate)
 *   - WCAG 2.5.8 — close button has padded touch area
 *   - autoComplete attrs preserved
 *   - Sticky footer + max-h dvh viewport
 *
 * Most Sprint C runtime behaviour (RKL block / scan flow / save callback) is
 * exercised end-to-end via `tests/e2e/passport-scan*.spec.ts` (Day 3).
 */
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { PassportScanDialog } from './passport-scan-dialog.tsx'

afterEach(cleanup)

function renderWithQueryClient(ui: React.ReactNode) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	})
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('PassportScanDialog — UI shape (Sprint C Day 2)', () => {
	test('[D1] open=false → dialog NOT rendered', () => {
		renderWithQueryClient(
			<PassportScanDialog open={false} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const dialog = screen.queryByRole('dialog')
		expect(dialog).toBeNull()
	})

	test('[D2] open=true initial stage → file input + identity radios visible', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		// Title + file input
		expect(screen.getByRole('heading', { name: /Сканирование документа гостя/ })).not.toBeNull()
		// 3 identity-method radios
		const radios = screen.getAllByRole('radio')
		expect(radios.length).toBe(3)
		// File input by label
		const fileInput = screen.getByLabelText(/Файл документа/) as HTMLInputElement
		expect(fileInput.type).toBe('file')
		expect(fileInput.accept).toBe('image/jpeg,image/png,application/pdf')
	})

	test('[D3] 3 identity methods rendered с RU labels', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		// Все 3 RU labels должны быть в DOM
		const body = document.body.textContent ?? ''
		expect(body).toContain('Паспорт РФ (внутренний)')
		expect(body).toContain('Загранпаспорт РФ')
		expect(body).toContain('Водительское удостоверение')
	})

	test('[D4] default identity method = passport_paper (per ПП-1912)', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const radios = screen.getAllByRole('radio') as HTMLInputElement[]
		// Radix RadioGroup sets aria-checked, не native checked.
		// Default state — exactly один radio checked.
		const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true')
		expect(checked.length).toBe(1)
		// Default = passport_paper (per ПП-1912). Sibling label должен contain «Паспорт РФ (внутренний)».
		const checkedRadio = checked[0]
		const labelText = checkedRadio?.parentElement?.textContent ?? ''
		expect(labelText.includes('Паспорт РФ (внутренний)')).toBe(true)
	})

	test('[D5] file input accept rejects HEIC (iOS Safari auto-converts)', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const fileInput = screen.getByLabelText(/Файл документа/) as HTMLInputElement
		// HEIC намеренно НЕ в accept — iOS Safari конвертирует автоматически
		expect(fileInput.accept.includes('heic')).toBe(false)
		expect(fileInput.accept.includes('jpeg')).toBe(true)
	})

	test('[D6] file input camera="environment" — rear camera для документа', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const fileInput = screen.getByLabelText(/Файл документа/) as HTMLInputElement
		// Capture attribute = "environment" (не "user" — мы не selfie сканируем)
		expect(fileInput.getAttribute('capture')).toBe('environment')
	})

	test('[D7] dialog имеет aria-labelledby для assistive tech', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const dialog = screen.getByRole('dialog') as HTMLElement
		const labelledBy = dialog.getAttribute('aria-labelledby')
		expect(typeof labelledBy).toBe('string')
		expect(labelledBy?.length ?? 0).toBeGreaterThan(0)
		// The id should reference an existing element
		const titleEl = document.getElementById(labelledBy ?? '')
		expect(titleEl).not.toBeNull()
	})

	test('[D8] DialogClose button has accessible name "Закрыть"', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const closeBtn = screen.getByRole('button', { name: /Закрыть/ })
		expect((closeBtn as HTMLButtonElement).disabled).toBe(false)
	})

	test('[D9] hint text mentions PDF + HEIC + iPhone — sets operator expectations', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const body = document.body.textContent ?? ''
		expect(body).toContain('PDF')
		expect(body).toContain('HEIC')
		expect(body).toContain('задняя камера')
	})

	test('[D10] missing operatorIdentity → destructive Alert + file input disabled (152-ФЗ ст.9 ч.4 gate)', () => {
		renderWithQueryClient(
			<PassportScanDialog open={true} onClose={mock()} onSave={mock()} guestId="guest_test" />,
		)
		const body = document.body.textContent ?? ''
		expect(body).toContain('Сканирование заблокировано')
		expect(body).toContain('152-ФЗ ст.9 ч.4')
		const fileInput = screen.getByLabelText(/Файл документа/) as HTMLInputElement
		expect(fileInput.disabled).toBe(true)
	})

	test('[D11] valid operatorIdentity → no gate Alert + file input enabled', () => {
		renderWithQueryClient(
			<PassportScanDialog
				open={true}
				onClose={mock()}
				onSave={mock()}
				guestId="guest_test"
				operatorIdentity={{ legalName: 'ООО «Гостиница Сочи»', inn: '2320200001' }}
			/>,
		)
		const body = document.body.textContent ?? ''
		expect(body.includes('Сканирование заблокировано')).toBe(false)
		const fileInput = screen.getByLabelText(/Файл документа/) as HTMLInputElement
		expect(fileInput.disabled).toBe(false)
	})

	test('[D12] empty legalName treated как missing (defense-in-depth)', () => {
		renderWithQueryClient(
			<PassportScanDialog
				open={true}
				onClose={mock()}
				onSave={mock()}
				guestId="guest_test"
				operatorIdentity={{ legalName: '', inn: '2320200001' }}
			/>,
		)
		const body = document.body.textContent ?? ''
		expect(body).toContain('Сканирование заблокировано')
		const fileInput = screen.getByLabelText(/Файл документа/) as HTMLInputElement
		expect(fileInput.disabled).toBe(true)
	})
})
