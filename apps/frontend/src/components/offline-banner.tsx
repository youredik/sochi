import { useIsMutating } from '@tanstack/react-query'
import { useOnlineStatus } from '@/lib/offline/online-status'

/**
 * Sticky offline-only indicator.
 *
 *   - Offline: amber banner «Нет соединения». Adds `В очереди: N` когда
 *     mutations паузнуты в ожидании сети (TanStack `useIsMutating` в offline-
 *     режиме считает paused mutations как pending).
 *   - Online:  hidden — no false positives on routine online XHR.
 *
 * Earlier v2 (2026-05-16) showed a separate «Синхронизация… N» banner whenever
 * `useIsMutating() > 0` regardless of network state. Empirically that produced
 * false positives — banner flashed on every POST (e.g. `find-by-inn` clicks)
 * even with the network healthy. Semantically «sync queue» belongs to the
 * offline mode; online loading state lives on the specific button / region
 * via mutation `isPending`. Reverted к offline-only signal 2026-05-22.
 *
 * WCAG 2.2 SC 4.1.3: `role="status"` + `aria-live="polite"` — non-blocking SR.
 */
export function OfflineBanner() {
	const isOnline = useOnlineStatus()
	const inFlight = useIsMutating()

	if (isOnline) return null

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
