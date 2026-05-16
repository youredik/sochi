import { createFileRoute } from '@tanstack/react-router'
import { useMediaQuery } from '../lib/use-media-query'
import { Chessboard } from '../features/chessboard/components/chessboard'
import { ChessboardMobile } from '../features/chessboard/components/chessboard-mobile'

/**
 * Reservation-grid route — `/o/{slug}/grid`. Parent `_app/o/$orgSlug`
 * already validated session + tenant membership, so the grid can load
 * without re-checking auth.
 *
 * G10 (2026-05-16) — breakpoint switch desktop vs mobile per R1+R2
 * canon (D-G10.12 + D-G10.13): capability-based detection (NOT viewport-
 * width) via `(hover: none) and (pointer: coarse)` — handles iPad-as-
 * laptop / Surface-hybrid correctly. Separate components, NOT responsive
 * variant — interaction surface diverges 100%.
 */
function GridRoute() {
	const isCoarse = useMediaQuery('(hover: none) and (pointer: coarse)')
	return isCoarse ? <ChessboardMobile /> : <Chessboard />
}

export const Route = createFileRoute('/_app/o/$orgSlug/grid')({
	component: GridRoute,
})
