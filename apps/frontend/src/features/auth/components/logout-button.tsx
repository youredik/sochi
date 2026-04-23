import { Button } from '@/components/ui/button'
import { useSignOut } from '../hooks/use-auth-mutations.ts'

export function LogoutButton() {
	const signOut = useSignOut()
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={() => signOut.mutate()}
			disabled={signOut.isPending}
		>
			{signOut.isPending ? 'Выходим…' : 'Выйти'}
		</Button>
	)
}
