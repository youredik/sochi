import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface InstallPromptState {
	dismissed: boolean
	dismiss: () => void
}

/**
 * InstallPrompt persistence — dismissed flag stays cross-session.
 *
 * Once user closed install banner — НЕ показывать снова в этом browser.
 * Reset через clear localStorage manually OR в dev tools (Settings).
 */
export const useInstallPromptStore = create<InstallPromptState>()(
	persist(
		(set) => ({
			dismissed: false,
			dismiss: () => set({ dismissed: true }),
		}),
		{
			name: 'horeca-install-prompt',
			storage: createJSONStorage(() => localStorage),
			partialize: (state) => ({ dismissed: state.dismissed }),
		},
	),
)

/**
 * isIosSafari — detect iOS Safari (НЕ Chrome iOS, НЕ in-app browser).
 *
 * Per `feedback_research_protocol.md` empirical-verified Round 4: in-app
 * browsers (Telegram, VK Messenger) ignore svh/dvh даже на iOS — наш PMS
 * должен открываться в standalone Safari. Detection возвращает false для
 * in-app browsers через UA check.
 */
export function isIosSafari(): boolean {
	if (typeof window === 'undefined') return false
	const ua = window.navigator.userAgent
	const isIos = /iPad|iPhone|iPod/.test(ua)
	const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua)
	return isIos && isSafari
}

/**
 * isStandalone — detect installed PWA (Add to Home Screen done).
 *
 * Two checks:
 *   - `display-mode: standalone` media query (Chrome / Android PWA)
 *   - `navigator.standalone === true` (iOS Safari legacy property)
 */
export function isStandalone(): boolean {
	if (typeof window === 'undefined') return false
	const mq = window.matchMedia('(display-mode: standalone)').matches
	const ios = (window.navigator as Navigator & { standalone?: boolean }).standalone === true
	return mq || ios
}
