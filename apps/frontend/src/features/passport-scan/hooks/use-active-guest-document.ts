/**
 * **2026-05-24** — useActiveGuestDocument hook
 *
 * Powers booking-edit-sheet hard-gate Заезд CTA per canonical May 2026 PMS UX
 * (Stayntouch / Mews / Cloudbeds): «check-in button disabled until passport
 * scan complete for foreign citizenship» per ПП-1912 от 27.11.2025 24-hour
 * МВД-учёт deadline.
 *
 * Returns minimal presence indicator (NO full PII per 152-ФЗ ст.18
 * minimization) — just identityMethod, masked last-4 of docNumber,
 * citizenshipIso3, scannedAt. RTBF-scrubbed rows excluded server-side so
 * revoked consent correctly re-blocks check-in re-attempt.
 *
 * Re-fetch на success of `useSaveDocumentFromScan` (handled by caller via
 * `queryClient.invalidateQueries`). staleTime=0 because operator wants
 * immediate update after scan; cache prevents N×fetch within same dialog
 * render burst.
 *
 * `enabled` flag — НЕ querying when guestId is null/empty, avoids spurious
 * 404 hammer on closed/blank booking-edit-sheet.
 *
 * Per 152-ФЗ canon: response payload is read-once + NOT persisted к
 * IndexedDB (meta.persist=false) — only in-memory during operator session.
 */

import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

export interface ActiveGuestDocument {
	readonly id: string
	readonly identityMethod: 'passport_paper' | 'passport_zagran' | 'driver_license'
	/** Last 4 chars of documentNumber. Operator-visible для verification, NOT full PII. */
	readonly documentNumberMaskedTail: string
	readonly citizenshipIso3: string
	/** ISO timestamp. */
	readonly scannedAt: string
}

export function useActiveGuestDocument(guestId: string | null | undefined) {
	return useQuery({
		queryKey: ['guest-document-active', guestId] as const,
		queryFn: async (): Promise<ActiveGuestDocument | null> => {
			if (!guestId) return null
			const res = await api.api.v1.guests[':guestId'].documents.active.$get({
				param: { guestId },
			})
			if (!res.ok) {
				const status = (res as Response).status
				if (status === 404) {
					// Cross-tenant guard tripped — surface как «no active document» rather
					// than throwing; UI behaves identically (Заезд disabled), и user не
					// видит cryptic error в edge case (stale booking after tenant switch).
					return null
				}
				throw new Error(`active-document HTTP ${status}`)
			}
			const body = (await res.json()) as { data: ActiveGuestDocument | null }
			return body.data
		},
		enabled: Boolean(guestId),
		staleTime: 0,
		// 152-ФЗ canon — last-4 masked но всё ещё quasi-identifier. Never persist.
		meta: { persist: false },
	})
}
