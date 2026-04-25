/**
 * Folio query options + mutations — TanStack Query 5.100 canonical 2026
 * patterns per `project_m6_7_frontend_research.md`.
 *
 * **Query key shape (locked in canon):**
 *   - `['folio', folioId]`              — header (balance, status, version)
 *   - `['folio', folioId, 'lines']`     — folioLine list
 *   - `['folio', folioId, 'payments']`  — payments tab
 *   - `['folio', folioId, 'refunds']`   — refunds tab (per-payment refund list)
 *   - `['folios', { bookingId }]`       — multi-folio per booking (Tabs source)
 *
 * **Stale strategy:**
 *   - Folio header: `staleTime: 0` + `refetchOnWindowFocus: true` +
 *     `refetchInterval: 15_000` (visible). CDC eventual-consistency window is
 *     sub-second; 15s polling + optimistic mutation update covers UX.
 *   - Lines/payments/refunds: `staleTime: 30_000` (less volatile).
 *
 * **No SSE / WebSocket** for live balance — Yandex Serverless Container has
 * SSE timeout caveat per memory `project_m5_tech_decisions`. 15s polling is
 * sufficient.
 *
 * **Idempotency-Key**: generated per-dialog-mount via `useMemo(() =>
 * crypto.randomUUID(), [])` (NOT here — dialog component owns it). Passed into
 * mutationFn via second arg `{ headers }`.
 *
 * **Optimistic mutations (mark-paid):** use `mutation.variables` rendering
 * pattern (NOT cache write). On `isPending`, render `variables.amountMinor` as
 * a pending row. `onSettled` invalidates relevant query keys to reconcile.
 */
import type { Folio, FolioLine, Payment, Refund } from '@horeca/shared'
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api.ts'

/* ============================================================== Folio header */

/**
 * Single-folio header data — balance, status, version, kind, currency.
 *
 * Pre-fetched in the route's `loader` via `queryClient.ensureQueryData`,
 * then read in the component via `useSuspenseQuery(folioQueryOptions(id))`.
 * Suspense boundary surfaces the route-level `pendingComponent` until the
 * fetch completes.
 */
export const folioQueryOptions = (folioId: string) =>
	queryOptions({
		queryKey: ['folio', folioId] as const,
		queryFn: async (): Promise<Folio> => {
			const res = await api.api.v1.folios[':id'].$get({ param: { id: folioId } })
			if (!res.ok) throw new Error(`folio.get HTTP ${res.status}`)
			const body = (await res.json()) as { data: Folio }
			return body.data
		},
		// Live balance — refetch on focus + every 15s while visible.
		staleTime: 0,
		refetchOnWindowFocus: true,
		refetchInterval: 15_000,
	})

/* =========================================================== Folio lines tab */

export const folioLinesQueryOptions = (folioId: string) =>
	queryOptions({
		queryKey: ['folio', folioId, 'lines'] as const,
		queryFn: async (): Promise<FolioLine[]> => {
			const res = await api.api.v1.folios[':id'].lines.$get({ param: { id: folioId } })
			if (!res.ok) throw new Error(`folio.lines HTTP ${res.status}`)
			const body = (await res.json()) as { data: FolioLine[] }
			return body.data
		},
		staleTime: 30_000,
	})

/* ====================================================== Folio payments tab */

export const folioPaymentsQueryOptions = (folioId: string) =>
	queryOptions({
		queryKey: ['folio', folioId, 'payments'] as const,
		queryFn: async (): Promise<Payment[]> => {
			const res = await api.api.v1.folios[':folioId'].payments.$get({ param: { folioId } })
			if (!res.ok) throw new Error(`folio.payments HTTP ${res.status}`)
			const body = (await res.json()) as { data: Payment[] }
			return body.data
		},
		staleTime: 30_000,
	})

/* ===================================================== Payment refunds list */

/**
 * Refunds for a specific payment — used in the refund Sheet's "available
 * amount" computation + on the Refunds tab if exposed separately.
 */
export const paymentRefundsQueryOptions = (paymentId: string) =>
	queryOptions({
		queryKey: ['payment', paymentId, 'refunds'] as const,
		queryFn: async (): Promise<Refund[]> => {
			const res = await api.api.v1.payments[':paymentId'].refunds.$get({ param: { paymentId } })
			if (!res.ok) throw new Error(`payment.refunds HTTP ${res.status}`)
			const body = (await res.json()) as { data: Refund[] }
			return body.data
		},
		staleTime: 30_000,
	})

/* ============================================================= Mark Paid mutation */

export interface MarkPaidVariables {
	propertyId: string
	bookingId: string
	folioId: string
	amountMinor: bigint
	method: 'card' | 'sbp' | 'cash' | 'bank_transfer' | 'stub'
	idempotencyKey: string
}

/**
 * Mark Paid (POST /properties/:p/bookings/:b/payments) with idempotency-key
 * header. Optimistic UI via `mutation.variables` rendering — no cache write,
 * no rollback bug surface. `onSettled` invalidates folio header + payments +
 * refunds (refund list cache could be affected if dispute-driven flow runs).
 */
export function useMarkPaid() {
	const qc = useQueryClient()
	return useMutation({
		mutationFn: async (vars: MarkPaidVariables): Promise<Payment> => {
			const res = await api.api.v1.properties[':propertyId'].bookings[':bookingId'].payments.$post(
				{
					param: { propertyId: vars.propertyId, bookingId: vars.bookingId },
					json: {
						folioId: vars.folioId,
						providerCode: 'stub',
						method: vars.method,
						// JSON.stringify не умеет serialize BigInt → TypeError. Backend
						// schema использует `z.coerce.bigint()` поэтому строка работает.
						// Поймано empirically через diagnostic playwright + console (M6.8.X).
						amountMinor: vars.amountMinor.toString(),
						currency: 'RUB',
						idempotencyKey: vars.idempotencyKey,
						saleChannel: 'direct',
					},
				},
				{
					headers: { 'Idempotency-Key': vars.idempotencyKey },
				},
			)
			if (!res.ok) throw new Error(`payment.create HTTP ${res.status}`)
			const body = (await res.json()) as { data: Payment; kind: 'created' | 'replayed' }
			return body.data
		},
		onSettled: (_data, _err, vars) =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ['folio', vars.folioId] }),
				qc.invalidateQueries({ queryKey: ['folio', vars.folioId, 'payments'] }),
				qc.invalidateQueries({ queryKey: ['folio', vars.folioId, 'lines'] }),
			]),
	})
}

/* ============================================================ Refund mutation */

export interface RefundCreateVariables {
	paymentId: string
	folioId: string
	amountMinor: bigint
	reason: string
	causality:
		| { kind: 'userInitiated'; userId: string }
		| { kind: 'dispute'; disputeId: string }
		| { kind: 'tkassa_cancel'; paymentId: string }
		| null
	idempotencyKey: string
}

export function useCreateRefund() {
	const qc = useQueryClient()
	return useMutation({
		mutationFn: async (vars: RefundCreateVariables): Promise<Refund> => {
			const res = await api.api.v1.payments[':paymentId'].refunds.$post(
				{
					param: { paymentId: vars.paymentId },
					json: {
						// Same BigInt-serialize issue как в useMarkPaid (M6.8.X catch).
						amountMinor: vars.amountMinor.toString(),
						reason: vars.reason,
						...(vars.causality !== null ? { causality: vars.causality } : {}),
					},
				},
				{
					headers: { 'Idempotency-Key': vars.idempotencyKey },
				},
			)
			if (!res.ok) throw new Error(`refund.create HTTP ${res.status}`)
			const body = (await res.json()) as { data: Refund }
			return body.data
		},
		onSettled: (_data, _err, vars) =>
			Promise.all([
				qc.invalidateQueries({ queryKey: ['folio', vars.folioId] }),
				qc.invalidateQueries({ queryKey: ['folio', vars.folioId, 'payments'] }),
				qc.invalidateQueries({ queryKey: ['payment', vars.paymentId, 'refunds'] }),
			]),
	})
}
