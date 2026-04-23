import { createFileRoute } from '@tanstack/react-router'
import { Chessboard } from '../features/chessboard/components/chessboard'

/**
 * Reservation-grid route — `/o/{slug}/grid`. Parent `_app/o/$orgSlug`
 * already validated session + tenant membership, so the grid can load
 * without re-checking auth.
 */
export const Route = createFileRoute('/_app/o/$orgSlug/grid')({
	component: Chessboard,
})
