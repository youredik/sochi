import { useEffect } from 'react'
import { toast } from 'sonner'
// biome-ignore lint/correctness/noUnresolvedImports: virtual:pwa-register/react is a runtime alias injected by vite-plugin-pwa; type declarations come via `<reference types="vite-plugin-pwa/react" />` in env.d.ts (verified empirically via typecheck clean).
import { useRegisterSW } from 'virtual:pwa-register/react'

/**
 * G11 (2026-05-16) — Service Worker update prompt per R2 ≥ 2026-05-16:
 *
 *   - `registerType: 'prompt'` (NOT autoUpdate) — operator has forms;
 *     auto-reload mid-edit = data loss
 *   - `useRegisterSW` hook from `virtual:pwa-register/react`
 *   - `needRefresh: true` → Sonner sticky action toast «Доступна новая
 *     версия» с [Обновить] button
 *   - `onOfflineReady` → one-shot toast «Приложение готово работать offline»
 */
export function SwUpdatePrompt() {
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		offlineReady: [offlineReady, setOfflineReady],
		updateServiceWorker,
	} = useRegisterSW({
		onRegistered(r: ServiceWorkerRegistration | undefined) {
			// Periodically check для new SW (every hour while tab open). A failed
			// `update()` (transient network blip) is non-actionable — swallow it so
			// the periodic check never raises an unhandled promise rejection.
			if (r) {
				setInterval(
					() => {
						r.update().catch(() => {})
					},
					60 * 60 * 1000,
				)
			}
		},
	})

	useEffect(() => {
		if (offlineReady) {
			toast.success('Приложение готово работать offline', {
				duration: 5000,
				onDismiss: () => setOfflineReady(false),
				onAutoClose: () => setOfflineReady(false),
			})
		}
	}, [offlineReady, setOfflineReady])

	useEffect(() => {
		if (needRefresh) {
			toast('Доступна новая версия', {
				id: 'sw-update',
				duration: Infinity,
				description: 'Сохраните изменения, затем обновите.',
				action: {
					label: 'Обновить',
					onClick: () => {
						void updateServiceWorker(true)
						setNeedRefresh(false)
					},
				},
			})
		}
	}, [needRefresh, setNeedRefresh, updateServiceWorker])

	return null
}
