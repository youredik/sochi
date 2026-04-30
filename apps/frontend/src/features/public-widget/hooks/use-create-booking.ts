/**
 * `useCreateBooking` — TanStack Query mutation для widget booking commit.
 *
 * Project canon (per `project_m6_7_frontend_research.md` + `use-folio-queries`
 * pattern): mutating endpoints wrapped в `useMutation` so consumers get
 * `isPending` / `isError` / `data` / `error` reactivity, retry control, and
 * coherent loading-state UX без bespoke per-component state.
 *
 * Idempotency-Key generation: caller passes the key (typically `useMemo(() =>
 * generateIdempotencyKey(), [])` per-mount). Same instance retries reuse the
 * same key — backend recognises replay. New mounts = fresh key. We DON'T
 * generate inside the hook because failed retries vs fresh-attempts must be
 * distinguishable, and that lifecycle belongs к the calling screen.
 *
 * No optimistic update: booking creation crosses 4 services (guest, booking,
 * payment, consents) + CDC fan-out — pure pessimistic mutation. UI shows
 * `isPending` overlay; on success navigates к confirmation; on error surfaces
 * the typed `WidgetBookingCommitError.reason`.
 */
import { useMutation } from '@tanstack/react-query'
import {
	commitBooking,
	type WidgetBookingCommitResult,
	type WidgetBookingCommitWireInput,
} from '../lib/widget-booking-api.ts'

export interface UseCreateBookingArgs {
	readonly tenantSlug: string
}

export interface CreateBookingMutationVariables {
	readonly body: WidgetBookingCommitWireInput
	readonly idempotencyKey: string
}

export function useCreateBooking({ tenantSlug }: UseCreateBookingArgs) {
	return useMutation<WidgetBookingCommitResult, Error, CreateBookingMutationVariables>({
		mutationFn: ({ body, idempotencyKey }) => commitBooking(tenantSlug, body, idempotencyKey),
		// retry: 0 — caller decides retry policy via component state. Auto-retry
		// without idempotency-key reuse coordination = double-charge risk.
		retry: 0,
	})
}
