import { Link, type LinkProps, useMatchRoute } from '@tanstack/react-router'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface MobileNavButtonProps extends Omit<LinkProps, 'children'> {
	icon: ComponentType<{ className?: string }>
	label: string
	children?: ReactNode
}

/**
 * MobileNavButton — bottom-tab destination compose.
 *
 * Touch target = 44×44 (Apple HIG canon = WCAG AAA, не 24px AA — research
 * golden middle Round 2): `min-w-11 min-h-11` (Tailwind v4 spacing 11 = 2.75rem
 * = 44px).
 *
 * Принципиально отдельный component от shadcn Button — не trogаем существующий
 * `Button` h-8 default (breaking change risk per plan §M9.2 W3 Round 5 self-audit).
 *
 * a11y:
 *   - `aria-current="page"` когда route активен (TanStack Router useMatchRoute)
 *   - lucide icon + visible label (НЕ icon-only — labelled bottom-nav канон 2026
 *     Vercel-pattern Feb 2026)
 *   - focus-visible ring через base Button — но композитно: использует raw <Link>
 *     для clean tab order
 */
export function MobileNavButton({ icon: Icon, label, ...linkProps }: MobileNavButtonProps) {
	const matchRoute = useMatchRoute()
	// Type-checking matchRoute через generic — strict types from TanStack Router.
	// `to`/`params` propagated через ...linkProps.
	const isActive = Boolean(matchRoute(linkProps as Parameters<typeof matchRoute>[0]))

	return (
		<Link
			{...linkProps}
			aria-current={isActive ? 'page' : undefined}
			className={cn(
				'flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-[11px] transition-colors',
				'text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
				isActive && 'text-foreground font-medium',
			)}
		>
			<Icon className="size-5" aria-hidden="true" />
			<span>{label}</span>
		</Link>
	)
}
