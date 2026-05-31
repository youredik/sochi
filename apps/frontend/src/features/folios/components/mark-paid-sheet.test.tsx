/**
 * `<MarkPaidSheet>` — FieldError real-message regression (2026-05-31).
 *
 * Same root cause + fix as RefundSheet: the form uses a FORM-LEVEL Zod validator
 * (`validators: { onSubmit }`) so `field.state.meta.errors` holds
 * StandardSchemaV1Issue OBJECTS, not strings. The old
 * `<FieldError>{String(field.state.meta.errors[0])}</FieldError>` rendered
 * "[object Object]"; fixed to shadcn-canonical `<FieldError errors={...} />`.
 * See `refund-sheet.test.tsx` for the full note + research provenance.
 *
 *   [E1] cleared `amount` → «Введите сумму», never "[object Object]"
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

const markPaidMutateAsync = mock(async () => ({ id: 'pay_1' }))

// bun:test `mock.module` is process-global (no per-file isolation) — provide the
// UNION of `use-folio-queries` exports that this AND refund-sheet.test.tsx import.
await mock.module('../hooks/use-folio-queries.ts', () => ({
	useMarkPaid: () => ({ mutateAsync: markPaidMutateAsync, isPending: false }),
	paymentRefundsQueryOptions: (id: string) => ({ queryKey: ['refunds', id] }),
	useCreateRefund: () => ({
		mutateAsync: mock(async () => ({ amountMinor: '0' })),
		isPending: false,
	}),
}))

await mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {} } }))

const { MarkPaidSheet } = await import('./mark-paid-sheet.tsx')

afterEach(() => {
	cleanup()
	markPaidMutateAsync.mockReset()
	markPaidMutateAsync.mockImplementation(async () => ({ id: 'pay_1' }))
})

describe('MarkPaidSheet — FieldError shows real message (no "[object Object]")', () => {
	it('[E1] cleared amount → «Введите сумму», never "[object Object]"', async () => {
		render(
			<MarkPaidSheet
				open
				onOpenChange={() => {}}
				propertyId="prop_1"
				bookingId="book_1"
				folioId="fol_1"
				currentBalanceMinor={500000n}
			/>,
		)
		const amount = screen.getByLabelText('Сумма') as HTMLInputElement
		fireEvent.change(amount, { target: { value: '' } })
		// «Принять» runs `form.handleSubmit()` — it validates the form-level Zod
		// schema, and the empty amount fails → error surfaces inline.
		fireEvent.click(screen.getByRole('button', { name: 'Принять' }))
		await waitFor(() => {
			expect(screen.queryByText('Введите сумму')).not.toBe(null)
		})
		expect(screen.queryByText('[object Object]')).toBe(null)
	})
})
