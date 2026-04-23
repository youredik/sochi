import { useSignOut } from '../hooks/use-auth-mutations.ts'

export function LogoutButton({ className }: { className?: string }) {
	const signOut = useSignOut()
	return (
		<button
			type="button"
			onClick={() => signOut.mutate()}
			disabled={signOut.isPending}
			className={
				className ??
				'inline-flex items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-60'
			}
		>
			{signOut.isPending ? 'Выходим…' : 'Выйти'}
		</button>
	)
}
