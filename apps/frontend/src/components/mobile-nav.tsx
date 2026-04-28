import { hasPermission } from '@horeca/shared'
import { useQuery } from '@tanstack/react-query'
import { BellIcon, BuildingIcon, CalendarIcon, MenuIcon, WalletIcon } from 'lucide-react'
import { MobileNavButton } from '@/components/mobile-nav-button'
import { Button } from '@/components/ui/button'
import { propertiesQueryOptions } from '@/features/receivables/hooks/use-receivables'
import { useCurrentRole } from '@/lib/use-can'

interface MobileNavProps {
	orgSlug: string
	onMoreClick: () => void
}

/**
 * MobileNav — sticky bottom-tab navigation для mobile breakpoint (<768px).
 *
 * 5 destinations canonical 2026 (Round 2 research, Vercel Feb 2026 redesign +
 * Linear/Notion pattern: 3-5 primary destinations):
 *   1. Шахматка        (CalendarIcon) — `/o/{slug}/grid`
 *   2. Дебиторка       (WalletIcon)   — `/o/{slug}/receivables`
 *   3. Профиль         (BuildingIcon) — `/o/{slug}/properties/{firstId}/content`
 *   4. Уведомления     (BellIcon)     — `/o/{slug}/admin/notifications`
 *   5. More            (MenuIcon)     — opens SidebarDrawer (Vaul)
 *
 * Profile/Notifications conditionally rendered по permission — иначе
 * placeholder hides (плотностью канон Linear: «settings hidden until needed»).
 *
 * a11y:
 *   - <nav role="navigation"> + aria-label
 *   - active route aria-current="page" (через MobileNavButton)
 *   - safe-area-inset-bottom — не уходит под home indicator на iOS PWA standalone
 *
 * Layout: `md:hidden` — bottom-tab показывается ТОЛЬКО на mobile. Desktop
 * (md+) использует existing top-header layout без изменений (per plan
 * §M9.2: «mobile-first refactor c md: prefixes для desktop»).
 */
export function MobileNav({ orgSlug, onMoreClick }: MobileNavProps) {
	const role = useCurrentRole()
	const properties = useQuery(propertiesQueryOptions)
	const firstProperty = properties.data?.[0]
	const canReadNotifications = role !== undefined && hasPermission(role, { notification: ['read'] })
	const canSeeContent =
		role !== undefined &&
		(hasPermission(role, { compliance: ['read'] }) || hasPermission(role, { amenity: ['read'] }))

	return (
		<nav
			aria-label="Главное меню"
			className="bg-background/95 border-border pb-safe-bottom fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t backdrop-blur md:hidden"
		>
			<MobileNavButton
				icon={CalendarIcon}
				label="Шахматка"
				to="/o/$orgSlug/grid"
				params={{ orgSlug }}
			/>
			<MobileNavButton
				icon={WalletIcon}
				label="Дебиторка"
				to="/o/$orgSlug/receivables"
				params={{ orgSlug }}
			/>
			{canSeeContent && firstProperty ? (
				<MobileNavButton
					icon={BuildingIcon}
					label="Профиль"
					to="/o/$orgSlug/properties/$propertyId/content"
					params={{ orgSlug, propertyId: firstProperty.id }}
				/>
			) : null}
			{canReadNotifications ? (
				<MobileNavButton
					icon={BellIcon}
					label="Уведомления"
					to="/o/$orgSlug/admin/notifications"
					params={{ orgSlug }}
				/>
			) : null}
			<Button
				type="button"
				variant="ghost"
				onClick={onMoreClick}
				aria-label="Дополнительные действия"
				className="text-muted-foreground hover:text-foreground flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-[11px]"
			>
				<MenuIcon className="size-5" aria-hidden="true" />
				<span>Ещё</span>
			</Button>
		</nav>
	)
}
