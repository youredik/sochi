import { createFileRoute } from '@tanstack/react-router'
import { Fingerprint, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { PasskeyEnrollButton } from '@/features/auth/components/passkey-enroll-button'
import { authClient } from '@/lib/auth-client'

/**
 * `/o/{orgSlug}/account/security` — security settings page.
 *
 * **M9.5 Phase D + M9.7 senior-pass:** wires `PasskeyEnrollButton` так что
 * unused-component knip warning eliminated. Lists registered passkeys via
 * `authClient.useListPasskeys()` atom hook + delete action per passkey.
 *
 * a11y: single h1 + section с aria-labelledby, list semantics через `<ul>`.
 * 152-ФЗ: passkeys = phishing-resistant 2FA (биометрия не покидает device,
 * server stores только public key + counter).
 */
export const Route = createFileRoute('/_app/o/$orgSlug/account/security')({
	component: AccountSecurityPage,
})

function AccountSecurityPage() {
	const passkeyHeadingId = useId()
	const passkeysQuery = authClient.useListPasskeys()
	const [deletingId, setDeletingId] = useState<string | null>(null)

	const handleDelete = async (id: string) => {
		setDeletingId(id)
		try {
			const res = await authClient.passkey.deletePasskey({ id })
			if (res?.error) {
				toast.error(res.error.message ?? 'Не удалось удалить passkey')
				return
			}
			toast.success('Passkey удалён')
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Ошибка удаления')
		} finally {
			setDeletingId(null)
		}
	}

	const passkeys = passkeysQuery.data ?? []

	return (
		<main className="container mx-auto max-w-2xl p-6 space-y-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">Безопасность</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					Passkey — passwordless вход через Touch ID / Face ID / Windows Hello. Биометрия не
					покидает устройство (152-ФЗ-friendly).
				</p>
			</header>

			<section aria-labelledby={passkeyHeadingId} className="space-y-4">
				<h2 id={passkeyHeadingId} className="text-lg font-medium">
					Passkey
				</h2>

				{passkeysQuery.isPending ? (
					<p className="text-muted-foreground text-sm">Загружаем список passkey…</p>
				) : passkeys.length === 0 ? (
					<p className="text-muted-foreground text-sm">Passkey ещё не добавлены.</p>
				) : (
					<ul className="space-y-2">
						{passkeys.map((pk) => (
							<li key={pk.id} className="flex items-center justify-between rounded-md border p-3">
								<div className="flex items-center gap-3">
									<Fingerprint className="text-muted-foreground size-4" aria-hidden="true" />
									<div>
										<div className="font-medium">{pk.name ?? 'Безымянный'}</div>
										<div className="text-muted-foreground text-xs">
											Добавлен{' '}
											<time dateTime={pk.createdAt.toString()}>
												{new Date(pk.createdAt).toLocaleDateString('ru-RU')}
											</time>
										</div>
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => handleDelete(pk.id)}
									disabled={deletingId === pk.id}
									aria-label={`Удалить passkey ${pk.name ?? pk.id}`}
								>
									<Trash2 className="size-4" aria-hidden="true" />
								</Button>
							</li>
						))}
					</ul>
				)}

				<PasskeyEnrollButton onEnrolled={() => passkeysQuery.refetch()} />
			</section>
		</main>
	)
}
