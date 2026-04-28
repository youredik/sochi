import { useEffect, useState } from 'react'

/**
 * useMediaQuery — local hook для CSS-media-query reactivity.
 *
 * Не вводим `usehooks-ts` ради одной утилиты (per platform-first philosophy:
 * меньше кастома, но и меньше deps когда платформенный API проще).
 *
 * Use cases в M9:
 *   - ThemeProvider: `(prefers-color-scheme: dark)` для system-mode auto-switch
 *   - Mobile shell M9.2: `(min-width: 768px)` для conditional Sheet/Drawer swap
 *   - Adaptive Шахматка M9.3: viewport-based default windowDays detection
 *
 * SSR-safe (initial state false при `typeof window === 'undefined'`) — у нас
 * Vite SPA, но guard на случай future миграции на TanStack Start.
 */
export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === 'undefined') return false
		return window.matchMedia(query).matches
	})

	useEffect(() => {
		const mq = window.matchMedia(query)
		const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
		mq.addEventListener('change', listener)
		// Sync initial value в случае race с Zustand hydration
		setMatches(mq.matches)
		return () => mq.removeEventListener('change', listener)
	}, [query])

	return matches
}
