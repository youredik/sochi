import { useEffect, useState } from 'react'

/**
 * G11 (2026-05-16) — `navigator.onLine` reactive hook per R1+R2 ≥ 2026-05-16
 * canon. NOT relying on `BackgroundSync` (Safari iOS gap); instead in-app
 * retry on `online`/`visibilitychange` events.
 *
 * SSR-safe (returns `true` server-side — optimistic). Subscribes к both:
 *   - `window.online` / `window.offline` — primary signal
 *   - `document.visibilitychange` — catches mobile-app-resume case where
 *     OS suspended events fired offline (per OneUptime 2026 BG-Sync canon)
 */
export function useOnlineStatus(): boolean {
	const [isOnline, setIsOnline] = useState(() => {
		if (typeof navigator === 'undefined') return true
		return navigator.onLine
	})

	useEffect(() => {
		function handleOnline() {
			setIsOnline(true)
		}
		function handleOffline() {
			setIsOnline(false)
		}
		function handleVisibility() {
			// Tab returned к foreground — re-check status. OS might have
			// dropped connection while suspended without firing 'offline'.
			if (document.visibilityState === 'visible') {
				setIsOnline(navigator.onLine)
			}
		}
		window.addEventListener('online', handleOnline)
		window.addEventListener('offline', handleOffline)
		document.addEventListener('visibilitychange', handleVisibility)
		return () => {
			window.removeEventListener('online', handleOnline)
			window.removeEventListener('offline', handleOffline)
			document.removeEventListener('visibilitychange', handleVisibility)
		}
	}, [])

	return isOnline
}
