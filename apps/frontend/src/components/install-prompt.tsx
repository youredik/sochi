import { DownloadIcon, ShareIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { isIosSafari, isStandalone, useInstallPromptStore } from '@/lib/install-prompt'

interface BeforeInstallPromptEvent extends Event {
	prompt: () => Promise<void>
	userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/**
 * InstallPrompt — encourages PWA install per platform.
 *
 * Three paths (per Round 3 research + plan §M9.4):
 *   1. Android Chrome / Edge: `beforeinstallprompt` event → show Install button
 *      that triggers native UA prompt via `prompt()`.
 *   2. iOS 26 Safari: NO programmatic prompt available (Apple restriction);
 *      show hint «Поделиться → На экран Домой» — iOS 26 added «Open as Web App»
 *      toggle by default ON в Share dialog (2025-09 release per research).
 *   3. Already standalone (PWA installed): hide.
 *
 * Dismissed cross-session — store persists в localStorage `horeca-install-prompt`.
 *
 * Layout: bottom-sheet style, mobile breakpoint only (`md:hidden` — desktop
 * users либо использовать Chromium «Install app» menu или browser bookmark).
 */
export function InstallPrompt() {
	const dismissed = useInstallPromptStore((state) => state.dismissed)
	const dismiss = useInstallPromptStore((state) => state.dismiss)
	const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null)
	const [showIosHint, setShowIosHint] = useState(false)

	useEffect(() => {
		if (dismissed || isStandalone()) return

		// Android beforeinstallprompt — capture event для later prompt()
		const onBeforeInstallPrompt = (e: Event) => {
			e.preventDefault()
			setInstallEvent(e as BeforeInstallPromptEvent)
		}
		window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)

		// iOS Safari — show hint после mount если detected
		if (isIosSafari()) {
			setShowIosHint(true)
		}

		return () => {
			window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
		}
	}, [dismissed])

	if (dismissed || isStandalone()) return null
	if (!installEvent && !showIosHint) return null

	const handleInstallClick = async () => {
		if (!installEvent) return
		await installEvent.prompt()
		const result = await installEvent.userChoice
		if (result.outcome === 'accepted') {
			setInstallEvent(null)
		}
	}

	return (
		<div
			role="dialog"
			aria-label="Установка приложения"
			className="bg-background border-border pb-safe-bottom fixed inset-x-0 bottom-20 z-50 mx-4 rounded-lg border p-4 shadow-lg md:hidden"
		>
			<div className="flex items-start justify-between gap-2">
				<div className="flex-1">
					<p className="text-sm font-semibold">Установить HoReCa</p>
					{installEvent ? (
						<p className="text-muted-foreground mt-1 text-xs">
							Запускайте без браузерной строки одним нажатием с экрана «Домой».
						</p>
					) : (
						<p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
							Нажмите <ShareIcon className="size-3" aria-hidden="true" /> «Поделиться» → «На экран
							Домой».
						</p>
					)}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					onClick={dismiss}
					aria-label="Закрыть подсказку"
					className="-mr-1 -mt-1 size-8"
				>
					<XIcon className="size-4" aria-hidden="true" />
				</Button>
			</div>
			{installEvent ? (
				<Button type="button" onClick={handleInstallClick} className="mt-3 min-h-11 w-full">
					<DownloadIcon className="mr-2 size-4" aria-hidden="true" />
					Установить приложение
				</Button>
			) : null}
		</div>
	)
}
