/**
 * `<FolioStatusBadge>` — shared status pill для folio screen +
 * receivables dashboard. Non-color signal: RU label per canon.
 */
import { Badge } from '../../../components/ui/badge.tsx'

export function FolioStatusBadge({ status }: { status: string }) {
	switch (status) {
		case 'open':
			return <Badge variant="outline">Открыто</Badge>
		case 'closed':
			return <Badge variant="secondary">Закрыто</Badge>
		case 'settled':
			return <Badge>Урегулировано</Badge>
		default:
			return <Badge variant="outline">{status}</Badge>
	}
}
