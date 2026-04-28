import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
	/** lucide-react icon component (single icon, NOT illustration). */
	icon?: ComponentType<{ className?: string }>
	/** Main message — h3 hierarchy. */
	title: string
	/** Secondary muted-foreground description. */
	description?: string
	/** Optional CTA button or link. */
	action?: ReactNode
	className?: string
}

/**
 * EmptyState — strict typography hierarchy для пустых list/grid views.
 *
 * Linear-strict canon: lucide single icon (NOT custom illustration), h3 →
 * muted body → optional action. Apply на:
 *   - Dashboard zero-properties (M9.5 first wire)
 *   - Receivables zero-invoices
 *   - Notifications zero-messages
 *   - Chessboard zero-roomTypes
 *
 * a11y: heading structure preserved, action focusable. Per plan §M9.5 5.6
 * + Round 5 research canon: «современный + строгость + простота».
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
	return (
		<div
			className={cn('flex flex-col items-center justify-center gap-4 py-12 text-center', className)}
		>
			{Icon ? (
				<div className="bg-muted flex size-12 items-center justify-center rounded-full">
					<Icon className="text-muted-foreground size-6" aria-hidden="true" />
				</div>
			) : null}
			<div className="flex max-w-md flex-col gap-1">
				<h3 className="text-base font-semibold tracking-tight">{title}</h3>
				{description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
			</div>
			{action != null ? <div className="mt-2">{action}</div> : null}
		</div>
	)
}
