import { hasPermission } from '@horeca/shared'
import { Link } from '@tanstack/react-router'
import { FileSpreadsheetIcon, GlobeIcon, IdCardIcon } from 'lucide-react'
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerHeader,
	DrawerTitle,
} from '@/components/ui/drawer'
import { LogoutButton } from '@/features/auth/components/logout-button'
import { OrgSwitcher } from '@/features/tenancy/components/org-switcher'
import { useCurrentRole } from '@/lib/use-can'

interface SidebarDrawerProps {
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
}

/**
 * SidebarDrawer — Vaul bottom-sheet для secondary mobile actions.
 *
 * Primary destinations live in MobileNav bottom-tab (Шахматка/Дебиторка/
 * Профиль/Уведомления). Secondary в drawer — opened через More-tab:
 *   - Туристический налог  (admin/tax)         — RBAC: `report:read`
 *   - Миграционный учёт    (admin/migration-*) — RBAC: `migrationRegistration:read`
 *   - OrgSwitcher          (multi-tenant)
 *   - LogoutButton
 *
 * a11y:
 *   - <DrawerTitle> + <DrawerDescription> obязательны для screen readers
 *     (Vaul wrap'ает Radix Dialog focus management)
 *   - Esc + outside-click + drag-down — все 3 close paths активны
 *   - safe-area-inset-bottom учёт через pb-safe-bottom на DrawerContent
 *
 * Vaul gotcha: НЕ вкладывать Drawer-в-Drawer (per plan §6.8). Пусть LogoutButton
 * confirm-dialog (если есть) использует Radix Dialog, не сам Drawer.
 */
export function SidebarDrawer({ orgSlug, open, onOpenChange }: SidebarDrawerProps) {
	const role = useCurrentRole()
	const canReadReports = role !== undefined && hasPermission(role, { report: ['read'] })
	const canReadMigration =
		role !== undefined && hasPermission(role, { migrationRegistration: ['read'] })

	return (
		<Drawer open={open} onOpenChange={onOpenChange}>
			<DrawerContent className="pb-safe-bottom">
				<DrawerHeader>
					<DrawerTitle>Дополнительные разделы</DrawerTitle>
					<DrawerDescription>
						Налог, миграционный учёт и переключение между организациями.
					</DrawerDescription>
				</DrawerHeader>
				<div className="flex flex-col gap-1 px-4 pb-4">
					{canReadReports ? (
						<Link
							to="/o/$orgSlug/admin/tax"
							params={{ orgSlug }}
							onClick={() => onOpenChange(false)}
							className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							<FileSpreadsheetIcon className="size-5" aria-hidden="true" />
							<span>Туристический налог</span>
						</Link>
					) : null}
					{canReadMigration ? (
						<Link
							to="/o/$orgSlug/admin/migration-registrations"
							params={{ orgSlug }}
							onClick={() => onOpenChange(false)}
							className="hover:bg-muted flex min-h-11 items-center gap-3 rounded-md px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							<IdCardIcon className="size-5" aria-hidden="true" />
							<span>Миграционный учёт</span>
						</Link>
					) : null}
					<div className="flex min-h-11 items-center gap-3 px-3">
						<GlobeIcon className="text-muted-foreground size-5" aria-hidden="true" />
						<OrgSwitcher />
					</div>
					<div className="px-3 pt-2">
						<LogoutButton />
					</div>
				</div>
			</DrawerContent>
		</Drawer>
	)
}
