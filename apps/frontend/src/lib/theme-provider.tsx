import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { useThemeStore } from './theme-store'
import { useMediaQuery } from './use-media-query'
import { viewTransitionApply } from './view-transition'

const META_LIGHT = '#ffffff'
const META_DARK = '#0a0a0a'

/**
 * ThemeProvider — apply'ит `<html class="dark">` based on theme-store + system pref.
 *
 * Architecture (research-grounded canon, 5 раундов):
 *   - Zustand persist держит user choice (light/dark/system) cross-session
 *   - matchMedia listener реагирует на OS theme switch когда theme === 'system'
 *   - View Transitions API даёт smooth cross-fade (с prefers-reduced-motion guard)
 *   - <meta name="theme-color"> static media= уже в index.html (FOUC-free initial render);
 *     JS-patch only at explicit user choice (light в dark-OS или наоборот) —
 *     hybrid approach (Round 4 self-audit decision)
 *
 * Important: `color-scheme` CSS property управляется CSS-каскадом
 * (`:root { color-scheme: light }` + `.dark { color-scheme: dark }`) —
 * НЕ через JS `style.colorScheme` (избегаем дублирования каскад/JS,
 * Round 3 self-audit fix W1).
 *
 * FOUC: prevented by inline-script в index.html `<head>` ПЕРЕД React mount.
 * ThemeProvider только синхронизирует на theme changes after mount.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
	const theme = useThemeStore((state) => state.theme)
	const systemPrefersDark = useMediaQuery('(prefers-color-scheme: dark)')
	const isFirstApply = useRef(true)

	useEffect(() => {
		const isDark = theme === 'dark' || (theme === 'system' && systemPrefersDark)

		// Skip View Transitions API на initial mount — FOUC-script уже apply'нул
		// .dark класс sync ПЕРЕД React render, transition snapshot тут лишний
		// (создаёт freeze во время form submission в первый paint frame).
		// Subsequent theme changes — c cross-fade transition.
		if (isFirstApply.current) {
			document.documentElement.classList.toggle('dark', isDark)
			isFirstApply.current = false
		} else {
			viewTransitionApply(() => {
				document.documentElement.classList.toggle('dark', isDark)
			})
		}

		// Sync `<meta theme-color>` (без media= attr) — overrides static media-static
		// fallback ТОЛЬКО при explicit user choice. Когда theme === 'system',
		// убираем JS-override чтобы static media-rule восстановился.
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
		if (meta) {
			if (theme === 'system') {
				meta.removeAttribute('content')
			} else {
				meta.setAttribute('content', isDark ? META_DARK : META_LIGHT)
			}
		}
	}, [theme, systemPrefersDark])

	return <>{children}</>
}
