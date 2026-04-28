import { Fingerprint, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'

interface Props {
	onSuccess?: () => void
	/**
	 * Conditional Mediation UI (WebAuthn L3 2026): browser auto-suggests
	 * passkey в username autofill suggestion поверх focus event без explicit
	 * click. iOS 18 / macOS Sequoia / Chrome 130+ supported. Default false
	 * для explicit-click UX; enable на login pages с email autofill chip.
	 */
	autoFill?: boolean
}

/**
 * PasskeySigninButton — passwordless signin через WebAuthn passkey.
 *
 * **Modern 2026/2027 canon:**
 * - `navigator.credentials.get()` через @simplewebauthn/browser 13.x
 * - Browser shows passkey picker (saved для current rpID)
 * - Touch/Face ID / Windows Hello / Android fingerprint user verification
 * - На success — Better Auth issues session cookie (same as password signin)
 *
 * **UX**: secondary button under password form на /login. Auto-suggests
 * passkey via Conditional Mediation UI (`mediation: 'conditional'`) если
 * browser supports — passkey appears в username autofill suggestions без
 * explicit click.
 */
export function PasskeySigninButton({ onSuccess, autoFill = false }: Props = {}) {
	const [pending, setPending] = useState(false)

	const handleSignin = async () => {
		setPending(true)
		try {
			const result = await authClient.signIn.passkey({ autoFill })
			if (result?.error) {
				toast.error(result.error.message ?? 'Не удалось войти через passkey')
				return
			}
			onSuccess?.()
		} catch (err) {
			const msg = err instanceof Error ? err.message : 'Ошибка входа через passkey'
			toast.error(msg)
		} finally {
			setPending(false)
		}
	}

	return (
		<Button type="button" variant="outline" onClick={handleSignin} disabled={pending}>
			{pending ? (
				<Loader2 className="size-4 animate-spin" aria-hidden="true" />
			) : (
				<Fingerprint className="size-4" aria-hidden="true" />
			)}
			<span>{pending ? 'Входим…' : 'Войти через passkey'}</span>
		</Button>
	)
}
