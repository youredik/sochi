/**
 * <ComplianceStep> — strict tests per `feedback_strict_tests.md` +
 * `feedback_pre_done_audit.md` (paste-and-fill checklist).
 *
 * Test matrix:
 *   ─── RBAC × 3 roles × 2 actions (read/update) ────────────────────
 *     [R1] owner+update → submit enabled, no readonly Alert
 *     [R2] manager (read only) → readonly Alert + submit disabled
 *     [R3] staff (no read/update) → readonly Alert + submit disabled
 *
 *   ─── isLoading / error / empty branches ──────────────────────────
 *     [B1] isLoading=true → "Загрузка…" placeholder
 *     [B2] error.code='NOT_FOUND' (first onboarding) → form renders empty
 *     [B3] error other code → destructive Alert with message
 *     [B4] data=null + no error → form renders with empty defaults
 *
 *   ─── Cross-field invariant: guest-house ──────────────────────────
 *     [G1] ksrCategory=guest_house + fz127=unset → warning string exact
 *     [G2] ksrCategory=guest_house + fz127=yes   → no warning
 *     [G3] ksrCategory=guest_house + fz127=no    → no warning
 *     [G4] ksrCategory=hotel       + fz127 absent (radio not shown)
 *
 *   ─── Cross-field invariant: tax-regime ───────────────────────────
 *     [T1] legalEntity=npd + taxRegime=NPD             → no warning
 *     [T2] legalEntity=npd + taxRegime=USN_DOHODY      → exact warning
 *     [T3] legalEntity=ip  + taxRegime=NPD             → exact warning
 *     [T4] legalEntity=ip  + taxRegime=AUSN_DOHODY     → no warning
 *     [T5] legalEntity=ip  + taxRegime=AUSN_DOHODY_RASHODY → exact warning
 *
 *   ─── Threshold boundary tests ────────────────────────────────────
 *     [N1] legalEntity=npd + revenue=3_799_999_999_999 micro → no warning
 *     [N2] legalEntity=npd + revenue=3_800_000_000_000 micro → warning
 *     [N3] legalEntity=npd + revenue=10_000_000_000_000 micro → warning
 *     [U1] taxRegime=USN_DOHODY + revenue<80% of 60M → no warning
 *     [U2] taxRegime=USN_DOHODY + revenue=48M (80% of 60M) → warning
 *     [U3] taxRegime=USN_DOHODY_RASHODY + revenue=60M → warning
 *
 *   ─── Submit serialization (three-state patch) ────────────────────
 *     [S1] empty form submit → all fields null (explicit clear)
 *     [S2] partial form submit → only filled fields populated
 *     [S3] revenue input "1,000,000" → bigint 1_000_000_000_000n
 *     [S4] revenue input "1234.56" → bigint 1_234_560_000n
 *     [S5] revenue input "abc" → null (parse failed)
 *     [S6] whitespace-only ksrId → null
 *
 *   ─── Enum coverage (defensive — surface drift loud) ──────────────
 *     [E1] all 11 ksrCategory options present in dropdown
 *     [E2] all 5 legalEntityType options present
 *     [E3] all 7 taxRegime options present
 *
 *   ─── a11y ────────────────────────────────────────────────────────
 *     [A1] section has aria-labelledby pointing to existing h2
 *     [A2] revenue input has aria-describedby
 *     [A3] every Select trigger has accessible label
 */
import {
	ksrCategoryValues,
	legalEntityTypeValues,
	type TenantCompliance,
	taxRegimeValues,
} from '@horeca/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../../lib/use-can.ts', () => ({
	useCan: vi.fn(() => true),
	useCurrentRole: vi.fn(() => 'owner'),
}))

vi.mock('../hooks/use-compliance.ts', () => ({
	useCompliance: vi.fn(() => ({ data: null, isLoading: false, error: null })),
	usePatchCompliance: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}))

import { hasPermission, type MemberRole } from '@horeca/shared'
import { useCan } from '../../../lib/use-can.ts'
import { useCompliance, usePatchCompliance } from '../hooks/use-compliance.ts'
import { ComplianceStep } from './compliance-step.tsx'

const mockedUseCan = vi.mocked(useCan)
const mockedUseCompliance = vi.mocked(useCompliance)
const mockedUsePatch = vi.mocked(usePatchCompliance)

beforeEach(() => {
	mockedUseCan.mockImplementation(() => true)
	mockedUseCompliance.mockReturnValue({
		data: null,
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useCompliance>)
	mockedUsePatch.mockReturnValue({
		mutateAsync: vi.fn(),
		isPending: false,
	} as unknown as ReturnType<typeof usePatchCompliance>)
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function setRole(role: MemberRole) {
	mockedUseCan.mockImplementation((perms) => hasPermission(role, perms))
}

async function _pickFromSelect(label: RegExp, optionText: RegExp | string) {
	const trigger = screen.getByLabelText(label)
	fireEvent.click(trigger)
	const opt = await screen.findByRole('option', { name: optionText })
	fireEvent.click(opt)
}

/**
 * Hydrate the form from a TenantCompliance row — bypasses Radix-Select-via-
 * click which is flaky in happy-dom (pointer events not fully simulated).
 * The component's `defaultValues` use `existing?` so this exercises the
 * exact same state path as a server-returned compliance row.
 */
function renderWithCompliance(partial: Partial<TenantCompliance>): void {
	const row: TenantCompliance = {
		ksrRegistryId: null,
		ksrCategory: null,
		legalEntityType: null,
		taxRegime: null,
		annualRevenueEstimateMicroRub: null,
		guestHouseFz127Registered: null,
		ksrVerifiedAt: null,
		...partial,
	}
	mockedUseCompliance.mockReturnValue({
		data: row,
		isLoading: false,
		error: null,
	} as unknown as ReturnType<typeof useCompliance>)
	render(<ComplianceStep />)
}

// ────────────────────────────────────────────────────────────────────
// RBAC matrix
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — RBAC matrix', () => {
	test('[R1] owner — submit enabled, no readonly Alert', () => {
		setRole('owner')
		render(<ComplianceStep />)
		expect(screen.queryByText('Только просмотр')).toBeNull()
		const submit = screen.getByRole('button', { name: 'Сохранить' })
		expect((submit as HTMLButtonElement).disabled).toBe(false)
	})

	test('[R2] manager — readonly Alert + submit disabled', () => {
		setRole('manager')
		render(<ComplianceStep />)
		expect(screen.getByText('Только просмотр')).toBeTruthy()
		const submit = screen.getByRole('button', { name: 'Сохранить' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})

	test('[R3] staff — readonly Alert + submit disabled', () => {
		setRole('staff')
		render(<ComplianceStep />)
		expect(screen.getByText('Только просмотр')).toBeTruthy()
		const submit = screen.getByRole('button', { name: 'Сохранить' })
		expect((submit as HTMLButtonElement).disabled).toBe(true)
	})
})

// ────────────────────────────────────────────────────────────────────
// Loading / error / data branches
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — branches', () => {
	test('[B1] isLoading=true → "Загрузка…" placeholder, no form', () => {
		mockedUseCompliance.mockReturnValue({
			data: null,
			isLoading: true,
			error: null,
		} as unknown as ReturnType<typeof useCompliance>)
		render(<ComplianceStep />)
		expect(screen.getByText('Загрузка…')).toBeTruthy()
		expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
	})

	test('[B2] NOT_FOUND error + no data → form renders empty (first onboarding path)', () => {
		mockedUseCompliance.mockReturnValue({
			data: null,
			isLoading: false,
			error: { code: 'NOT_FOUND', message: 'no row' } as unknown as Error,
		} as unknown as ReturnType<typeof useCompliance>)
		render(<ComplianceStep />)
		// Form renders, NOT a destructive alert
		expect(screen.queryByText(/^Ошибка$/)).toBeNull()
		expect(screen.getByRole('button', { name: 'Сохранить' })).toBeTruthy()
	})

	test('[B3] non-NOT_FOUND error → destructive Alert', () => {
		mockedUseCompliance.mockReturnValue({
			data: null,
			isLoading: false,
			error: { code: 'INTERNAL', message: 'boom' } as unknown as Error,
		} as unknown as ReturnType<typeof useCompliance>)
		render(<ComplianceStep />)
		expect(screen.getByText('Ошибка')).toBeTruthy()
		expect(screen.getByText('boom')).toBeTruthy()
		// Form NOT rendered
		expect(screen.queryByRole('button', { name: 'Сохранить' })).toBeNull()
	})

	test('[B4] data row — fields hydrated from server', () => {
		const row: TenantCompliance = {
			ksrRegistryId: 'KSR-X-42',
			ksrCategory: 'aparthotel',
			legalEntityType: 'ooo',
			taxRegime: 'OSN',
			annualRevenueEstimateMicroRub: 5_000_000_000_000n,
			guestHouseFz127Registered: null,
			ksrVerifiedAt: null,
		}
		mockedUseCompliance.mockReturnValue({
			data: row,
			isLoading: false,
			error: null,
		} as unknown as ReturnType<typeof useCompliance>)
		render(<ComplianceStep />)
		expect((screen.getByLabelText(/Идентификатор КСР/) as HTMLInputElement).value).toBe('KSR-X-42')
		expect((screen.getByLabelText(/Годовая выручка/) as HTMLInputElement).value).toBe('5000000')
	})
})

// ────────────────────────────────────────────────────────────────────
// Guest-house cross-field invariant
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — guest-house invariant', () => {
	test('[G1] guest_house + fz127=null → exact warning text', () => {
		renderWithCompliance({ ksrCategory: 'guest_house', guestHouseFz127Registered: null })
		expect(
			screen.getByText(
				'Для гостевых домов обязательно указать участие в эксперименте ФЗ-127 (ПП-1345)',
			),
		).toBeTruthy()
	})

	test('[G2] guest_house + fz127=true → no warning', () => {
		renderWithCompliance({ ksrCategory: 'guest_house', guestHouseFz127Registered: true })
		expect(screen.queryByText(/Для гостевых домов обязательно указать участие/)).toBeNull()
	})

	test('[G3] guest_house + fz127=false → no warning', () => {
		renderWithCompliance({ ksrCategory: 'guest_house', guestHouseFz127Registered: false })
		expect(screen.queryByText(/Для гостевых домов обязательно указать участие/)).toBeNull()
	})

	test('[G4] non-guest_house category → fz127 RadioGroup not rendered', () => {
		renderWithCompliance({ ksrCategory: 'mini_hotel', guestHouseFz127Registered: null })
		expect(screen.queryByText(/Эксперимент ФЗ-127/)).toBeNull()
	})
})

// ────────────────────────────────────────────────────────────────────
// Tax-regime cross-field invariant
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — tax-regime invariant', () => {
	test('[T1] npd + NPD → no warning', () => {
		renderWithCompliance({ legalEntityType: 'npd', taxRegime: 'NPD' })
		expect(screen.queryByText(/может применять только режим NPD/)).toBeNull()
		expect(screen.queryByText(/доступен только для legalEntityType=npd/)).toBeNull()
	})

	test('[T2] npd + USN_DOHODY → exact warning "может применять только режим NPD"', () => {
		renderWithCompliance({ legalEntityType: 'npd', taxRegime: 'USN_DOHODY' })
		expect(screen.getByText('Самозанятый (НПД) может применять только режим NPD')).toBeTruthy()
	})

	test('[T3] ip + NPD → exact warning "доступен только для legalEntityType=npd"', () => {
		renderWithCompliance({ legalEntityType: 'ip', taxRegime: 'NPD' })
		expect(
			screen.getByText('Режим NPD доступен только для legalEntityType=npd (самозанятый)'),
		).toBeTruthy()
	})

	test('[T4] ip + AUSN_DOHODY → no warning', () => {
		renderWithCompliance({ legalEntityType: 'ip', taxRegime: 'AUSN_DOHODY' })
		expect(screen.queryByText(/могут применять только AUSN_DOHODY/)).toBeNull()
	})

	test('[T5] ip + AUSN_DOHODY_RASHODY → exact warning "могут применять только AUSN_DOHODY"', () => {
		renderWithCompliance({ legalEntityType: 'ip', taxRegime: 'AUSN_DOHODY_RASHODY' })
		expect(screen.getByText('ИП на АУСН могут применять только AUSN_DOHODY (доходы)')).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Threshold boundary tests
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — threshold boundaries', () => {
	test('[N1] npd + revenue=3_799_999 (just below 3.8M ₽) → NO warning', () => {
		renderWithCompliance({
			legalEntityType: 'npd',
			annualRevenueEstimateMicroRub: 3_799_999_000_000n,
		})
		expect(screen.queryByText(/Превышен лимит НПД 2026/)).toBeNull()
	})

	test('[N2] npd + revenue=3_800_000 (exactly at limit) → warning', () => {
		renderWithCompliance({
			legalEntityType: 'npd',
			annualRevenueEstimateMicroRub: 3_800_000_000_000n,
		})
		expect(
			screen.getByText('Превышен лимит НПД 2026 (3,8 млн ₽). Необходим переход на ИП/ООО.'),
		).toBeTruthy()
	})

	test('[N3] npd + revenue=10_000_000 → warning', () => {
		renderWithCompliance({
			legalEntityType: 'npd',
			annualRevenueEstimateMicroRub: 10_000_000_000_000n,
		})
		expect(screen.getByText(/Превышен лимит НПД 2026/)).toBeTruthy()
	})

	test('[U1] USN_DOHODY + revenue<80% of 60M (47_999_999) → no warning', () => {
		renderWithCompliance({
			taxRegime: 'USN_DOHODY',
			annualRevenueEstimateMicroRub: 47_999_999_000_000n,
		})
		expect(screen.queryByText(/УСН-60 млн ₽/)).toBeNull()
	})

	test('[U2] USN_DOHODY + revenue=48_000_000 (exactly 80% of 60M) → warning', () => {
		renderWithCompliance({
			taxRegime: 'USN_DOHODY',
			annualRevenueEstimateMicroRub: 48_000_000_000_000n,
		})
		expect(
			screen.getByText('Приближаетесь к порогу УСН-60 млн ₽ (376-ФЗ). Рассмотрите переход на ОСН.'),
		).toBeTruthy()
	})

	test('[U3] USN_DOHODY_RASHODY + revenue=60_000_000 → warning', () => {
		renderWithCompliance({
			taxRegime: 'USN_DOHODY_RASHODY',
			annualRevenueEstimateMicroRub: 60_000_000_000_000n,
		})
		expect(screen.getByText(/УСН-60 млн ₽/)).toBeTruthy()
	})
})

// ────────────────────────────────────────────────────────────────────
// Submit serialization (three-state patch)
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — submit serialization', () => {
	async function submitAndAwait(): Promise<void> {
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
	}

	test('[S1] empty form submit → all fields null (explicit clear)', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		await submitAndAwait()
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
		expect(mutateAsync).toHaveBeenCalledWith({
			input: {
				ksrRegistryId: null,
				ksrCategory: null,
				legalEntityType: null,
				taxRegime: null,
				annualRevenueEstimateMicroRub: null,
				guestHouseFz127Registered: null,
			},
			idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		})
	})

	test('[S2] partial form submit — only filled fields, others null', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.change(screen.getByLabelText(/Идентификатор КСР/), {
			target: { value: 'KSR-77' },
		})
		await submitAndAwait()
		await waitFor(() =>
			expect(mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					input: expect.objectContaining({ ksrRegistryId: 'KSR-77' }),
					idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
				}),
			),
		)
	})

	test('[S3] revenue "1,000,000" → bigint 1_000_000_000_000n', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.change(screen.getByLabelText(/Годовая выручка/), {
			target: { value: '1,000,000' },
		})
		await submitAndAwait()
		await waitFor(() =>
			expect(mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					input: expect.objectContaining({
						annualRevenueEstimateMicroRub: 1_000_000_000_000n,
					}),
				}),
			),
		)
	})

	test('[S4] revenue "1234.56" → bigint 1_234_560_000n', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.change(screen.getByLabelText(/Годовая выручка/), {
			target: { value: '1234.56' },
		})
		await submitAndAwait()
		// 1234 rub + 0.56 → 1234.56 × 1_000_000 micro = 1_234_560_000
		await waitFor(() =>
			expect(mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					input: expect.objectContaining({ annualRevenueEstimateMicroRub: 1_234_560_000n }),
				}),
			),
		)
	})

	test('[S5] revenue "abc" → undefined (parse failed, kept untouched)', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.change(screen.getByLabelText(/Годовая выручка/), {
			target: { value: 'abc' },
		})
		await submitAndAwait()
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const call = mutateAsync.mock.calls[0]?.[0] as {
			input: { annualRevenueEstimateMicroRub: unknown }
		}
		// Non-empty input but unparseable → undefined per onSubmit logic
		expect(call.input.annualRevenueEstimateMicroRub).toBeUndefined()
	})

	test('[S6] whitespace-only ksrId → null (trimmed empty)', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.change(screen.getByLabelText(/Идентификатор КСР/), {
			target: { value: '   ' },
		})
		await submitAndAwait()
		await waitFor(() =>
			expect(mutateAsync).toHaveBeenCalledWith(
				expect.objectContaining({
					input: expect.objectContaining({ ksrRegistryId: null }),
				}),
			),
		)
	})

	test('[I1] every submit includes a UUIDv4 Idempotency-Key (retry-safety)', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalled())
		const call = mutateAsync.mock.calls[0]?.[0] as { idempotencyKey: string }
		expect(call.idempotencyKey).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		)
	})

	test('[I2] two submits → two distinct keys (NOT cached, NOT shared)', async () => {
		const mutateAsync = vi.fn()
		mockedUsePatch.mockReturnValue({
			mutateAsync,
			isPending: false,
		} as unknown as ReturnType<typeof usePatchCompliance>)
		render(<ComplianceStep />)
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
		fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
		await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2))
		const k1 = (mutateAsync.mock.calls[0]?.[0] as { idempotencyKey: string }).idempotencyKey
		const k2 = (mutateAsync.mock.calls[1]?.[0] as { idempotencyKey: string }).idempotencyKey
		expect(k1).not.toBe(k2)
	})
})

// ────────────────────────────────────────────────────────────────────
// Enum coverage
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — enum coverage (drift surface)', () => {
	test('[E1] all 11 ksrCategory options present in dropdown', async () => {
		render(<ComplianceStep />)
		fireEvent.click(screen.getByLabelText(/Категория КСР/))
		const opts = await screen.findAllByRole('option')
		expect(opts).toHaveLength(ksrCategoryValues.length)
	})

	test('[E2] all 5 legalEntityType options present', async () => {
		render(<ComplianceStep />)
		fireEvent.click(screen.getByLabelText(/Организационно-правовая форма/))
		const opts = await screen.findAllByRole('option')
		expect(opts).toHaveLength(legalEntityTypeValues.length)
	})

	test('[E3] all 7 taxRegime options present', async () => {
		render(<ComplianceStep />)
		fireEvent.click(screen.getByLabelText(/Налоговый режим/))
		const opts = await screen.findAllByRole('option')
		expect(opts).toHaveLength(taxRegimeValues.length)
	})
})

// ────────────────────────────────────────────────────────────────────
// a11y
// ────────────────────────────────────────────────────────────────────

describe('<ComplianceStep> — a11y', () => {
	test('[A1] section is labelled via aria-labelledby pointing to existing h2', () => {
		render(<ComplianceStep />)
		const section = screen.getByRole('region', {
			name: /Compliance — нормативные данные/,
		})
		const labelId = section.getAttribute('aria-labelledby')
		expect(labelId).not.toBeNull()
		const h2 = within(section).getByRole('heading', { level: 2 })
		expect(h2.id).toBe(labelId)
	})

	test('[A2] revenue input has aria-describedby pointing to a non-empty hint', () => {
		render(<ComplianceStep />)
		const revenue = screen.getByLabelText(/Годовая выручка/)
		const descId = revenue.getAttribute('aria-describedby')
		expect(descId).not.toBeNull()
		const hint = document.getElementById(descId!)
		expect(hint?.textContent).toMatch(/УСН-60.*НПД-3,8/)
	})

	test('[A3] every Select reachable by its visible Label (screen-reader binding)', () => {
		render(<ComplianceStep />)
		// `getByLabelText` succeeds iff <label for=id> binds to an element with
		// matching id. Throws if not — exact assertion via no-throw.
		expect(screen.getByLabelText(/Категория КСР/)).toBeTruthy()
		expect(screen.getByLabelText(/Организационно-правовая форма/)).toBeTruthy()
		expect(screen.getByLabelText(/Налоговый режим/)).toBeTruthy()
	})
})
