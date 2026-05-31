/**
 * `<RefundSheet>` — FieldError real-message regression (2026-05-31).
 *
 * Root cause guarded here: the form uses a FORM-LEVEL Zod validator
 * (`validators: { onSubmit }`), so TanStack Form v1 stores StandardSchemaV1Issue
 * OBJECTS (`{ message }`) in `field.state.meta.errors` — NOT strings. (Confirmed
 * against shadcn/ui «TanStack Form» docs + TanStack validation guide, 2026:
 * field-level validators returning a string yield string errors; a schema
 * validator yields issue objects.) The old
 * `<FieldError>{String(field.state.meta.errors[0])}</FieldError>` collapsed the
 * object to the useless "[object Object]". Fixed to the shadcn-canonical
 * `<FieldError errors={field.state.meta.errors} />` which maps issues → `.message`.
 *
 * These tests FAIL on the old `String(errors[0])` markup and PASS on the fix.
 *
 *   [E1] empty `reason`  → «Укажите причину возврата», never "[object Object]"
 *   [E2] cleared `amount` → «Введите сумму», never "[object Object]"
 */
import type { Payment } from '@horeca/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

const createRefundMutateAsync = mock(async () => ({ amountMinor: '0' }))

// useQuery (refunds history) → empty list so availableMinor > 0 and «Далее» is enabled.
await mock.module('@tanstack/react-query', () => ({
	useQuery: () => ({ data: [], isLoading: false, isPending: false, error: null }),
	useQueryClient: () => ({ invalidateQueries: () => {} }),
	queryOptions: <T,>(opts: T) => opts,
}))

// bun:test `mock.module` is process-global (no per-file isolation), so this and
// mark-paid-sheet.test.tsx both mock the SAME module — provide the UNION of
// exports both components import so neither resolves to `undefined`.
await mock.module('../hooks/use-folio-queries.ts', () => ({
	paymentRefundsQueryOptions: (id: string) => ({ queryKey: ['refunds', id] }),
	useCreateRefund: () => ({ mutateAsync: createRefundMutateAsync, isPending: false }),
	useMarkPaid: () => ({ mutateAsync: mock(async () => ({ id: 'pay_x' })), isPending: false }),
}))

await mock.module('../../../lib/auth-client.ts', () => ({
	authClient: { useSession: () => ({ data: { user: { id: 'usr_1' } } }) },
}))

await mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

const { RefundSheet } = await import('./refund-sheet.tsx')

// Only `id`, `capturedMinor`, `createdAt` are read by the form — cast the partial.
const PAYMENT = {
	id: 'pay_1',
	capturedMinor: '500000',
	createdAt: '2026-05-01T10:00:00.000Z',
} as unknown as Payment

afterEach(() => {
	cleanup()
	createRefundMutateAsync.mockReset()
	createRefundMutateAsync.mockImplementation(async () => ({ amountMinor: '0' }))
})

describe('RefundSheet — FieldError shows real message (no "[object Object]")', () => {
	it('[E1] empty reason → «Укажите причину возврата», never "[object Object]"', async () => {
		render(<RefundSheet open onOpenChange={() => {}} payment={PAYMENT} folioId="fol_1" />)
		// «Далее» runs `form.validate('submit')` (form-level Zod) — reason is empty
		// by default, so the gate stays on the form step and surfaces the error.
		fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
		await waitFor(() => {
			expect(screen.queryByText('Укажите причину возврата')).not.toBe(null)
		})
		expect(screen.queryByText('[object Object]')).toBe(null)
	})

	it('[E2] cleared amount → «Введите сумму», never "[object Object]"', async () => {
		render(<RefundSheet open onOpenChange={() => {}} payment={PAYMENT} folioId="fol_1" />)
		const amount = screen.getByLabelText('Сумма к возврату') as HTMLInputElement
		fireEvent.change(amount, { target: { value: '' } })
		fireEvent.click(screen.getByRole('button', { name: 'Далее' }))
		await waitFor(() => {
			expect(screen.queryByText('Введите сумму')).not.toBe(null)
		})
		expect(screen.queryByText('[object Object]')).toBe(null)
	})
})
