import type {
	AvailabilityCheckResult,
	PropertyBlock,
	PropertyBlockCreateInput,
	PropertyBlockReason,
} from '@horeca/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../../lib/api.ts'
import { errorFromResponse, extractApiError } from '../../../lib/api-errors.ts'
import { logger } from '../../../lib/logger.ts'

/**
 * G9 (2026-05-16) — property-block (OOO/maintenance) + availability hooks
 * per R1+R2 ≥ 2026-05-16 research-agent (Mews ResourceBlock / Apaleo /
 * OPERA / Cloudbeds / Bnovo industry canon).
 *
 * - `useAvailabilityCheck` — debounced live overlap check for booking-
 *   create-sheet (300ms desktop, 500ms pointer:coarse mobile)
 * - `useCreatePropertyBlocks` — multi-room create (Bnovo-flex partial-success)
 *
 * NB: list-blocks fetch is co-located в `useGridData` так chessboard
 * single-source-of-truth grid data в one hook (avoids prop-drilling
 * separate cache state). Delete-block hook deferred к G9.next когда
 * edit-sheet UI is added.
 */

/**
 * Debounced live availability check для booking-create-sheet (G9 Surface 1).
 *
 * - 300ms debounce desktop / 500ms pointer:coarse (mobile) per R2 canon
 * - `enabled: hasCompleteTriple` — no API call until checkIn/checkOut/
 *   roomTypeId all filled + checkIn < checkOut
 * - TanStack Query cancels stale requests via internal AbortController
 *
 * Returns `data: AvailabilityCheckResult | undefined` so caller can
 * derive UX: availableCount === 0 → red banner; blockedCount > 0 → hint
 * «заблокирован для обслуживания».
 */
export function useAvailabilityCheck(
	propertyId: string | null,
	roomTypeId: string,
	checkIn: string,
	checkOut: string,
) {
	const debounceMs = isCoarsePointer() ? 500 : 300
	const debouncedTriple = useDebouncedValue({ roomTypeId, checkIn, checkOut }, debounceMs)
	const hasCompleteTriple = Boolean(
		propertyId &&
		debouncedTriple.roomTypeId &&
		debouncedTriple.checkIn &&
		debouncedTriple.checkOut &&
		debouncedTriple.checkIn < debouncedTriple.checkOut,
	)
	return useQuery({
		queryKey: [
			'availability-check',
			propertyId,
			debouncedTriple.roomTypeId,
			debouncedTriple.checkIn,
			debouncedTriple.checkOut,
		] as const,
		queryFn: async () => {
			if (!propertyId || !hasCompleteTriple) {
				throw new Error('availability-check: incomplete triple — should not have run')
			}
			const res = await api.api.v1.properties[':propertyId'].availability.$get({
				param: { propertyId },
				query: {
					roomTypeId: debouncedTriple.roomTypeId,
					from: debouncedTriple.checkIn,
					to: debouncedTriple.checkOut,
				},
			})
			if (!res.ok) throw new Error('availability-check failed')
			const body = (await res.json()) as { data: AvailabilityCheckResult }
			return body.data
		},
		enabled: hasCompleteTriple,
		staleTime: 1_000,
	})
}

interface CreateBlocksResult {
	created: PropertyBlock[]
	skipped: Array<{ roomId: string; reason: string }>
}

/**
 * Multi-room create. On block-over-booking conflict (409) — surfaces
 * canonical RU toast pointing operator at the room IDs they need к free.
 */
export function useCreatePropertyBlocks(propertyId: string | null) {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: async (input: PropertyBlockCreateInput) => {
			if (!propertyId) throw new Error('propertyId required')
			const res = await api.api.v1.properties[':propertyId'].blocks.$post({
				param: { propertyId },
				json: input,
			})
			if (!res.ok) {
				const err = await errorFromResponse(res)
				throw err
			}
			const body = (await res.json()) as { data: CreateBlocksResult }
			return body.data
		},
		onSuccess: (data) => {
			void queryClient.invalidateQueries({ queryKey: ['property-blocks', propertyId] })
			void queryClient.invalidateQueries({ queryKey: ['availability-check'] })
			const total = data.created.length + data.skipped.length
			if (data.skipped.length === 0) {
				toast.success(`Создано блокировок: ${data.created.length}`, {
					description: 'Номера помечены недоступными для бронирования.',
				})
			} else if (data.created.length === 0) {
				toast.warning('Не удалось создать блокировки', {
					description: `Пропущено: ${data.skipped.length} из ${total}.`,
				})
			} else {
				toast.success(
					`Создано: ${data.created.length}, пропущено: ${data.skipped.length} из ${total}`,
					{ description: 'Часть номеров уже заблокирована или неактивна.' },
				)
			}
		},
		onError: (err) => {
			const apiErr = extractApiError(err)
			if (apiErr?.code === 'PROPERTY_BLOCK_BOOKING_CONFLICT') {
				toast.error('Невозможно заблокировать', {
					description:
						'В выбранных номерах уже есть активные брони. Сначала перенесите или отмените их.',
				})
				return
			}
			logger.error('property-block.create failed', { err })
			toast.error('Ошибка при создании блокировки', {
				description: apiErr?.message ?? 'Попробуйте ещё раз или обратитесь в поддержку.',
			})
		},
	})
}

/** RU labels for the propertyBlock.reason enum. Co-located here to
 *  avoid bouncing through @horeca/shared for a UI-only mapping (shared
 *  exports propertyBlockReasonLabelsRu — we re-export-friendly read). */
export const propertyBlockReasonLabels: Record<PropertyBlockReason, string> = {
	repair: 'Ремонт',
	deep_clean: 'Генеральная уборка',
	personal_use: 'Личное пользование',
	hold_other: 'Прочая блокировка',
}

// --- internal helpers ---

/**
 * Trailing-edge debounce. ~10 LOC alternative to adding `@tanstack/react-
 * pacer` dep for one-time use. Empirical sweet-spot canon (300ms desktop)
 * stays parametric. Resets the timer на every value change.
 *
 * `value` must be a plain object — deep-equal compare via JSON.stringify
 * (cheap для shallow flat shapes; if shape grows, swap к dequal lib).
 */
function useDebouncedValue<T>(value: T, ms: number): T {
	const [debounced, setDebounced] = useState(value)
	const key = JSON.stringify(value)
	// biome-ignore lint/correctness/useExhaustiveDependencies: value is captured via the stable JSON `key` (deep-equal compare). Listing raw `value` would trigger reference-equality re-runs on every parent render (defeats debounce). Same canon as TanStack Query's `queryKey` JSON-equality optimization.
	useEffect(() => {
		const id = setTimeout(() => setDebounced(value), ms)
		return () => clearTimeout(id)
	}, [key, ms])
	return debounced
}

/** SSR-safe pointer:coarse media-query check (mobile / touch-first). */
function isCoarsePointer(): boolean {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
	try {
		return window.matchMedia('(pointer: coarse)').matches
	} catch {
		return false
	}
}
