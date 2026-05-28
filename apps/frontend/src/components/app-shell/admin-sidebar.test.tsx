/**
 * AdminSidebar — strict integration tests (A.bis.2 RBAC × 8 sections mount).
 *
 * Pre-done audit (per `feedback_strict_tests.md`):
 *   RBAC mount × 3 roles (full enum coverage):
 *     [R-owner]   role=owner   → 8 sections rendered (full)
 *     [R-manager] role=manager → 8 sections rendered (full)
 *     [R-staff]   role=staff   → 3 sections rendered (grid + profile + guests)
 *     [R-staff-hidden-recv]    receivables NOT in DOM
 *     [R-staff-hidden-channels] channels NOT in DOM
 *     [R-staff-hidden-tax]     tax NOT in DOM
 *     [R-staff-hidden-notif]   notifications NOT in DOM
 *
 *   Loading states:
 *     [P1] role=undefined → no menu items rendered (deny-by-default canon)
 *     [P2] profile needsPropertyId AND no properties → profile HIDDEN
 *     [P3] profile needsPropertyId AND properties present → profile rendered
 *
 *   Composition / structure:
 *     [S1] every rendered row has data-section-id attribute
 *     [S2] menu has aria-label="Главное меню" (D15 canon)
 *     [S3] sidebar has data-slot="sidebar"
 *
 *   Footer composition:
 *     [F1] DemoModeBadge mounted in footer (data-slot present when mode loaded)
 *     [F2] mode='demo' → demo-mode-badge data-mode="demo"
 *
 *   D15 dev-warn — no missing aria-label warnings under this consumer:
 *     [W1] every <SidebarMenuButton> rendered with explicit aria-label →
 *          PATCH-D15 dev warn fires zero times (we honour our own canon)
 */

import type { MemberRole, TenantMode } from '@horeca/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from '@testing-library/react'
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from 'bun:test'

// Mock TanStack Router Link так чтобы AdminSidebar тестировался без
// router-context (canonical pattern from `widget-page.test.tsx`).
mock.module('@tanstack/react-router', () => ({
	Link: ({
		children,
		to,
		params,
		'data-section-id': dataSectionId,
		// activeProps / activeOptions consumed by real Link; mock ignores
		// them since happy-dom has no router state to drive `active`.
		activeProps: _activeProps,
		activeOptions: _activeOptions,
		...props
	}: {
		children: React.ReactNode
		to: string
		params?: Record<string, string>
		'data-section-id'?: string
		activeProps?: unknown
		activeOptions?: unknown
		[k: string]: unknown
	}) => {
		const href = params
			? Object.entries(params).reduce(
					(acc, [k, v]) => acc.replace(`$${k}`, encodeURIComponent(v)),
					to,
				)
			: to
		return (
			// biome-ignore lint/suspicious/noExplicitAny: spreading router-extra props onto <a> in test scaffolding.
			<a href={href} data-section-id={dataSectionId} {...(props as any)}>
				{children}
			</a>
		)
	},
}))

// Stub heavy footer consumers to keep this test focused on AdminSidebar's
// own logic (RBAC × 8 sections rendering + propertyId dispatch + footer
// composition slots). Each stub is a self-identifying inert element.
mock.module('@/features/auth/components/logout-button', () => ({
	LogoutButton: () => (
		<button type="button" data-stub="logout">
			Выйти
		</button>
	),
}))
mock.module('@/features/tenancy/components/org-switcher', () => ({
	OrgSwitcher: () => <span data-stub="org-switcher">OrgSwitcher</span>,
}))
mock.module('@/components/mode-toggle', () => ({
	ModeToggle: () => (
		<button type="button" data-stub="mode-toggle">
			Тема
		</button>
	),
}))

// Stub mocked window.matchMedia so SidebarProvider's useIsMobile() resolves
// to desktop default (matches PMS hotelier ergonomics — sidebar is the
// primary navigation surface; mobile is exception).
function mockMatchMedia(isDesktop: boolean) {
	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		configurable: true,
		value: mock().mockImplementation((query: string) => ({
			matches: query.includes('min-width: 768px') ? isDesktop : false,
			media: query,
			onchange: null,
			addEventListener: mock(),
			removeEventListener: mock(),
			dispatchEvent: mock(),
			addListener: mock(),
			removeListener: mock(),
		})),
	})
}

import { SidebarProvider } from '@/components/ui/sidebar'
import { propertiesQueryOptions } from '@/features/receivables/hooks/use-receivables'
import { meQueryOptions } from '@/lib/use-can'
import { AdminSidebar } from './admin-sidebar'

let queryClient: QueryClient
let warnSpy: Mock<(...args: unknown[]) => unknown>

function seed({
	role,
	mode = 'production',
	withProperty = true,
}: {
	role?: MemberRole
	mode?: TenantMode
	withProperty?: boolean
}) {
	if (role !== undefined) {
		queryClient.setQueryData(meQueryOptions.queryKey, {
			userId: 'usr-test',
			tenantId: 'org-test',
			role,
			mode,
		})
	}
	if (withProperty) {
		// Minimal Property shape — only `id` is read by AdminSidebar; cast
		// avoids constructing 12 unused fields just to satisfy the type.
		queryClient.setQueryData(propertiesQueryOptions.queryKey, [
			// biome-ignore lint/suspicious/noExplicitAny: test-only narrow Property stub
			{ id: 'prop-1', name: 'Тестовый отель' } as any,
		])
	} else {
		queryClient.setQueryData(propertiesQueryOptions.queryKey, [])
	}
}

function renderSidebar() {
	return render(
		<QueryClientProvider client={queryClient}>
			<SidebarProvider defaultOpen>
				<AdminSidebar orgSlug="aurora" />
			</SidebarProvider>
		</QueryClientProvider>,
	)
}

beforeEach(() => {
	mockMatchMedia(true)
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
	})
	warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
	spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
	cleanup()
	queryClient.clear()
	mock.restore()
})

function getRenderedSectionIds(): string[] {
	return Array.from(document.querySelectorAll('[data-section-id]')).map(
		(el) => el.getAttribute('data-section-id') ?? '',
	)
}

/* -------------------------------------------------------------------------- */
/*  RBAC × 3 roles (full enum coverage)                                       */
/* -------------------------------------------------------------------------- */

describe('AdminSidebar — RBAC × 3 roles (mounted section ids)', () => {
	it('[R-owner] role=owner → 9 sections rendered (full incl. demo)', () => {
		seed({ role: 'owner' })
		renderSidebar()
		const ids = getRenderedSectionIds().sort()
		expect(ids).toEqual(
			[
				'channels',
				'demo',
				'grid',
				'guests',
				'inventory',
				'notifications',
				'profile',
				'receivables',
				'tax',
			].sort(),
		)
	})

	it('[R-manager] role=manager → 9 sections rendered (full incl. demo)', () => {
		seed({ role: 'manager' })
		renderSidebar()
		const ids = getRenderedSectionIds().sort()
		expect(ids).toEqual(
			[
				'channels',
				'demo',
				'grid',
				'guests',
				'inventory',
				'notifications',
				'profile',
				'receivables',
				'tax',
			].sort(),
		)
	})

	it('[R-staff] role=staff → exactly 3 sections (grid + profile + guests)', () => {
		seed({ role: 'staff' })
		renderSidebar()
		const ids = getRenderedSectionIds().sort()
		expect(ids).toEqual(['grid', 'guests', 'profile'])
	})

	it('[R-staff-hidden] staff: receivables/channels/tax/notifications all HIDDEN', () => {
		seed({ role: 'staff' })
		renderSidebar()
		for (const hidden of ['receivables', 'channels', 'tax', 'notifications']) {
			expect(document.querySelector(`[data-section-id="${hidden}"]`)).toBeNull()
		}
	})
})

/* -------------------------------------------------------------------------- */
/*  Loading states                                                            */
/* -------------------------------------------------------------------------- */

describe('AdminSidebar — loading states', () => {
	it('[P1] role=undefined → no menu items rendered (deny-by-default canon)', () => {
		// Don't seed role; properties seeded so propertyId is irrelevant.
		seed({ withProperty: true })
		renderSidebar()
		expect(getRenderedSectionIds()).toEqual([])
	})

	it('[P2] profile needsPropertyId AND no properties → profile HIDDEN', () => {
		seed({ role: 'owner', withProperty: false })
		renderSidebar()
		const ids = getRenderedSectionIds()
		expect(ids).not.toContain('profile')
		// Other 7 sections still rendered (owner has all permissions); inventory
		// also hidden because it needsPropertyId per I7 canon. demo doesn't need
		// propertyId → renders.
		expect(ids.sort()).toEqual(
			['channels', 'demo', 'grid', 'guests', 'notifications', 'receivables', 'tax'].sort(),
		)
	})

	it('[P3] profile needsPropertyId AND properties present → profile rendered with $propertyId', () => {
		seed({ role: 'owner', withProperty: true })
		renderSidebar()
		const profile = document.querySelector('[data-section-id="profile"]')
		expect(profile).not.toBeNull()
		// Mock Link substitutes $propertyId with the seeded id.
		expect(profile?.getAttribute('href')).toContain('/properties/prop-1/content')
	})
})

/* -------------------------------------------------------------------------- */
/*  Composition / structure                                                   */
/* -------------------------------------------------------------------------- */

describe('AdminSidebar — composition / structure', () => {
	it('[S1] every rendered row has data-section-id attribute', () => {
		seed({ role: 'owner' })
		renderSidebar()
		const items = document.querySelectorAll('[data-sidebar="menu-item"]')
		expect(items.length).toBe(9)
		for (const item of items) {
			const link = item.querySelector('[data-section-id]')
			expect(link).not.toBeNull()
		}
	})

	it('[S2] menu has aria-label="Главное меню" (D15 canon)', () => {
		seed({ role: 'owner' })
		renderSidebar()
		const menu = document.querySelector('[data-sidebar="menu"]')
		expect(menu?.getAttribute('aria-label')).toBe('Главное меню')
	})

	it('[S3] sidebar has data-slot="sidebar"', () => {
		seed({ role: 'owner' })
		renderSidebar()
		expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
	})
})

/* -------------------------------------------------------------------------- */
/*  Footer composition                                                        */
/* -------------------------------------------------------------------------- */

describe('AdminSidebar — footer composition', () => {
	it('[F1] DemoModeBadge mounted in footer when mode loaded', () => {
		seed({ role: 'owner', mode: 'production' })
		renderSidebar()
		const badge = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(badge).not.toBeNull()
		const footer = document.querySelector('[data-sidebar="footer"]')
		expect(footer?.contains(badge)).toBe(true)
	})

	it('[F2] mode=demo → badge data-mode="demo"', () => {
		seed({ role: 'owner', mode: 'demo' })
		renderSidebar()
		const badge = document.querySelector('[data-slot="demo-mode-badge"]')
		expect(badge?.getAttribute('data-mode')).toBe('demo')
	})

	it('[F3] footer mounts ModeToggle + LogoutButton stubs', () => {
		seed({ role: 'owner' })
		renderSidebar()
		expect(document.querySelector('[data-stub="mode-toggle"]')).not.toBeNull()
		expect(document.querySelector('[data-stub="logout"]')).not.toBeNull()
	})

	it('[F4] header mounts OrgSwitcher stub', () => {
		seed({ role: 'owner' })
		renderSidebar()
		const header = document.querySelector('[data-sidebar="header"]')
		expect(header?.querySelector('[data-stub="org-switcher"]')).not.toBeNull()
	})
})

/* -------------------------------------------------------------------------- */
/*  D15 dev-warn: own consumer honours canon (zero warnings)                  */
/* -------------------------------------------------------------------------- */

describe('AdminSidebar — D15 dev-warn: own consumer honours aria-label canon', () => {
	it('[W1] zero "missing aria-label" warnings — every menu button labelled', () => {
		seed({ role: 'owner' })
		renderSidebar()
		const offending = warnSpy.mock.calls.filter((args) =>
			String(args[0]).includes('without an explicit `aria-label`'),
		)
		expect(offending.length).toBe(0)
	})
})
