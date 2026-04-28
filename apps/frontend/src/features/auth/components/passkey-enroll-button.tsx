import { Fingerprint, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'

interface Props {
	defaultName?: string
	onEnrolled?: () => void
}

/**
 * PasskeyEnrollButton — добавляет новый passkey к текущей сессии.
 *
 * **Modern 2026/2027 canon (WebAuthn L3):**
 * - `navigator.credentials.create()` через @simplewebauthn/browser 13.x
 *   обёртку (под капотом @better-auth/passkey/client)
 * - Browser prompts platform authenticator (Touch/Face ID, Windows Hello,
 *   Android fingerprint)
 * - 152-ФЗ-friendly: биометрия НЕ покидает device
 *
 * **UX**: single button с `Fingerprint` icon (lucide). Loading state via
 * Loader2 spinner. Error toast (not Alert) per existing form-pattern canon.
 *
 * **Default name**: `navigator.userAgent`-derived (e.g. «MacBook Air» from
 * UA-CH if available, fallback «Безымянный passkey»). User может override
 * через optional `defaultName` prop (e.g. settings page asks для label).
 */
export function PasskeyEnrollButton({ defaultName, onEnrolled }: Props = {}) {
	const [pending, setPending] = useState(false)

	const handleEnroll = async () => {
		setPending(true)
		try {
			const name = defaultName ?? deriveDeviceName()
			const result = await authClient.passkey.addPasskey({ name })
			if (result?.error) {
				toast.error(result.error.message ?? 'Не удалось добавить passkey')
				return
			}
			toast.success(`Passkey «${name}» добавлен`)
			onEnrolled?.()
		} catch (err) {
			// User cancelled OR hardware unavailable.
			const msg = err instanceof Error ? err.message : 'Ошибка регистрации passkey'
			toast.error(msg)
		} finally {
			setPending(false)
		}
	}

	return (
		<Button type="button" variant="outline" onClick={handleEnroll} disabled={pending}>
			{pending ? (
				<Loader2 className="size-4 animate-spin" aria-hidden="true" />
			) : (
				<Fingerprint className="size-4" aria-hidden="true" />
			)}
			<span>{pending ? 'Регистрируем…' : 'Добавить passkey'}</span>
		</Button>
	)
}

/**
 * Best-effort device label from UA. Modern browsers expose UA-CH (User-Agent
 * Client Hints) для precise device hints; legacy fallback parses `navigator.
 * userAgent`. Always returns non-empty string.
 */
function deriveDeviceName(): string {
	if (typeof navigator === 'undefined') return 'Passkey'
	const ua = navigator.userAgent
	if (/iPhone/i.test(ua)) return 'iPhone'
	if (/iPad/i.test(ua)) return 'iPad'
	if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac'
	if (/Windows/i.test(ua)) return 'Windows'
	if (/Android/i.test(ua)) return 'Android'
	if (/Linux/i.test(ua)) return 'Linux'
	return 'Passkey'
}
