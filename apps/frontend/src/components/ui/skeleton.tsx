import { cn } from '@/lib/utils'

/**
 * Skeleton — shimmer animation на default + pulse fallback при
 * `prefers-reduced-motion: reduce` (handled in index.css).
 *
 * a11y: caller responsibility передать `role="status"` + `aria-busy="true"` +
 * sr-only «Загрузка» label на parent container (Skeleton sами по себе только
 * visual placeholder). Pattern см. chessboard.tsx loading state.
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
	return (
		<div
			data-slot="skeleton"
			className={cn('skeleton-shimmer rounded-md', className)}
			{...props}
		/>
	)
}

export { Skeleton }
