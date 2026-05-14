/**
 * AdminSidebar — hotelier admin app-shell sidebar instance.
 *
 * Plan canon `plans/track-a-bis-canonical.md` §6 architecture + §10 RBAC
 * matrix + §11 RU labels. Renders 7 destinations (per plan D28 «no vapor»),
 * gated by `hasPermission()` (rows hidden, not greyed — D29). Single
 * `<SidebarProvider>` lives in `_app.tsx` per D14 canon (PATCH-D14 in
 * `ui/sidebar.tsx` enforces dev-only).
 *
 * Composition (per §6 architecture diagram):
 *   <Sidebar collapsible="offcanvas">
 *     <SidebarHeader>
 *       <OrgSwitcher/>
 *     <SidebarContent>
 *       <SidebarGroup>
 *         <SidebarMenu>
 *           7× <SidebarMenuItem><SidebarMenuButton asChild>…<Link/>
 *     <SidebarFooter>
 *       <DemoModeBadge/> + <ModeToggle/> + <LogoutButton/>
 *
 * a11y (per §12):
 *   - aria-label="Главное меню" on `<Sidebar>` (D15 canon)
 *   - explicit Cyrillic aria-label on every <SidebarMenuButton> (D15)
 *   - tooltip prop = secondary descriptor for collapsed icon-rail
 *   - <Link activeProps={{ 'aria-current': 'page' }} activeOptions exact>
 *     — D22, prevents nested-route double-current
 *
 * Profile section needs `propertyId`: we look up the active tenant's first
 * property via TanStack Query and hide the section while loading or if the
 * tenant has zero properties (defensive — content wizard should have run).
 */

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ModeToggle } from '@/components/mode-toggle'
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
} from '@/components/ui/sidebar'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LogoutButton } from '@/features/auth/components/logout-button'
import { propertiesQueryOptions } from '@/features/receivables/hooks/use-receivables'
import { OrgSwitcher } from '@/features/tenancy/components/org-switcher'
import { useCurrentRole } from '@/lib/use-can'
import { DemoModeBadge } from './demo-mode-badge'
import { SIDEBAR_SECTIONS } from './sidebar-sections'

interface AdminSidebarProps {
	orgSlug: string
}

export function AdminSidebar({ orgSlug }: AdminSidebarProps) {
	const role = useCurrentRole()
	const properties = useQuery(propertiesQueryOptions)
	const firstPropertyId = properties.data?.[0]?.id

	return (
		// TooltipProvider wraps the whole app-shell sidebar so collapsed
		// icon-rail tooltips emitted by <SidebarMenuButton tooltip={…}> have
		// the required Radix Tooltip context. Single provider per shell —
		// shadcn-canonical placement (mirrors plan §6 architecture diagram
		// «Tooltip primitive re-use»).
		<TooltipProvider delayDuration={0}>
			<Sidebar collapsible="offcanvas">
				<SidebarHeader>
					<div className="flex items-center justify-between gap-2">
						<span className="text-sm font-semibold tracking-tight">HoReCa</span>
						<OrgSwitcher />
					</div>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupContent>
							<SidebarMenu aria-label="Главное меню">
								{SIDEBAR_SECTIONS.map((section) => {
									if (role === undefined) return null
									if (!section.isVisible(role)) return null
									if (section.needsPropertyId && !firstPropertyId) return null
									const Icon = section.icon
									const params: Record<string, string> = section.needsPropertyId
										? { orgSlug, propertyId: firstPropertyId as string }
										: { orgSlug }
									return (
										<SidebarMenuItem key={section.id}>
											<SidebarMenuButton
												asChild
												aria-label={section.ariaLabelRu}
												tooltip={section.labelRu}
											>
												{/*
												TanStack Router auto-emits `data-status="active"` on
												the rendered <a>. We add `aria-current="page"` via
												activeProps. `activeOptions={{ exact: true }}` prevents
												nested routes (e.g. `/admin/channels/:id`) from also
												marking the parent `/admin/channels` row active —
												plan §4 D22.
											*/}
												<Link
													to={section.to}
													// biome-ignore lint/suspicious/noExplicitAny: TanStack Router typed routes vs dynamic params dispatch — narrowing would require a per-section switch over 7 routes; runtime params are route-aware (orgSlug always; propertyId iff needed).
													params={params as any}
													activeProps={{ 'aria-current': 'page' }}
													activeOptions={
														section.activeOnPrefix === true
															? // For sections с sub-tabs (e.g. inventory с /rooms+/rate-plans+/prices),
																// strip the leaf segment from `to` so any /inventory/* path highlights.
																{ exact: false }
															: { exact: true }
													}
													data-section-id={section.id}
												>
													<Icon aria-hidden="true" />
													<span>{section.labelRu}</span>
												</Link>
											</SidebarMenuButton>
										</SidebarMenuItem>
									)
								})}
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
				<SidebarFooter>
					<div className="flex items-center justify-between gap-2">
						<DemoModeBadge />
						<div className="flex items-center gap-1">
							<ModeToggle />
							<LogoutButton />
						</div>
					</div>
				</SidebarFooter>
				<SidebarRail />
			</Sidebar>
		</TooltipProvider>
	)
}
