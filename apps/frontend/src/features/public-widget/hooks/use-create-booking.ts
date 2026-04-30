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
 * same key — backend recognises replay. New mounts = fresh key. The key is
 * captured в the mutation closure при mutateAsync({ ..., idempotencyKey })
 * call, so retries automatically use the SAME key. ЮKassa canon (24h dedup).
 *
 * Retry strategy (2026 spot-research 2026-04-30 confirmed canonical):
 * Stripe / ЮKassa / Adyen all explicitly recommend retry с same Idempotency-Key
 * на TRANSIENT failures (network throw + 5xx) для idempotent POST. Default
 * `retry: 0` of TanStack Query — safety default for unknown case; once you
 * have server-side dedup (we do — `(tenantId, idempotencyKey)` UNIQUE 24h),
 * retry IS canonical. NEVER retry 4xx (deterministic — wastes dedup window
 * + confuses UX).
 *
 * - Cap: 2 retries (3 attempts total) — Stripe-node default.
 * - Backoff: exponential 1s/2s/4s capped at 8s + jitter 0-250ms (avoids
 *   thundering herd).
 *
 * No optimistic update: booking creation crosses 4 services (guest, booking,
 * payment, consents) + CDC fan-out — pure pessimistic mutation. UI shows
 * `isPending` overlay; on success navigates к confirmation; on error surfaces
 * the typed `WidgetBookingCommitError.reason`.
 */
import { useMutation } from '@tanstack/react-query'
import {
	commitBooking,
	WidgetBookingCommitError,
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

const MAX_RETRIES = 2

/**
 * Decide if a failure should be retried. Pure function — exported для unit
 * test без TanStack Query QueryClient setup.
 *
 * Retry only on:
 *   - `WidgetBookingCommitError` `reason: 'network'` (fetch threw)
 *   - `WidgetBookingCommitError` `reason: 'server'` (5xx)
 *   - Unknown errors (defensive — treat as transient до cap)
 *
 * Skip retry on:
 *   - `validation` / `consent_missing` / `stale_availability` / `not_found` /
 *     `rate_limited` (deterministic; retry just wastes dedup window)
 */
export function shouldRetryBookingMutation(failureCount: number, error: unknown): boolean {
	if (failureCount >= MAX_RETRIES) return false
	if (error instanceof WidgetBookingCommitError) {
		return error.reason === 'network' || error.reason === 'server'
	}
	// Defensive: unknown error shape → treat as transient
	return true
}

/** Exponential backoff с jitter. Pure function — exported для unit test. */
export function bookingRetryDelay(attempt: number): number {
	const base = Math.min(1000 * 2 ** attempt, 8000)
	return base + Math.random() * 250
}

export function useCreateBooking({ tenantSlug }: UseCreateBookingArgs) {
	return useMutation<WidgetBookingCommitResult, Error, CreateBookingMutationVariables>({
		mutationFn: ({ body, idempotencyKey }) => commitBooking(tenantSlug, body, idempotencyKey),
		retry: shouldRetryBookingMutation,
		retryDelay: bookingRetryDelay,
	})
}
