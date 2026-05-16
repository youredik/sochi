import { useIsMutating } from '@tanstack/react-query'
import { useOnlineStatus } from '@/lib/offline/online-status'

/**
 * G11 v2 (2026-05-16) — sticky offline indicator per R1+R2 ≥ 2026-05-15 canon:
 *   - Offline: amber banner «Нет соединения…»
 *   - Online + in-flight mutations: blue banner «Синхронизация… N»
 *   - All clear: hidden
 *
 * v1 used Dexie queue count via useLiveQuery — dropped per «don't reinvent
 * TanStack» canon. `useIsMutating` from TanStack Query gives the same
 * signal natively (per-query mutation counter built-in).
 *
 * WCAG 2.2 SC 4.1.3: `role="status"` `aria-live="polite"` — non-blocking SR.
 */
export function OfflineBanner() {
	const isOnline = useOnlineStatus()
	const inFlight = useIsMutating()

	if (isOnline && inFlight === 0) return null

	if (!isOnline) {
		return (
			<div
				className="sticky top-0 z-50 w-full border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900"
				role="status"
				aria-live="polite"
				data-slot="offline-banner"
				data-state="offline"
			>
				Нет соединения. Действия будут отправлены при восстановлении сети.
				{inFlight > 0 ? ` В очереди: ${inFlight}.` : ''}
			</div>
		)
	}

	return (
		<div
			className="sticky top-0 z-50 w-full border-b border-blue-300 bg-blue-50 px-4 py-2 text-sm text-blue-900"
			role="status"
			aria-live="polite"
			data-slot="offline-banner"
			data-state="syncing"
		>
			Синхронизация… в очереди: {inFlight}
		</div>
	)
}
