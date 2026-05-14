/**
 * Sidebar sections — single source of truth for the admin app-shell nav.
 *
 * Plan canon `plans/track-a-bis-canonical.md` §11: 7 active destinations
 * (no vapor / no disabled-future per `feedback_no_halfway.md`). RBAC
 * predicates verified empirically against `packages/shared/src/rbac.ts`
 * 2026-05-12 full read (143 lines).
 *
 * Visibility matrix (per plan §10):
 *
 *   | id              | owner | manager | staff | predicate                                  |
 *   |-----------------|-------|---------|-------|--------------------------------------------|
 *   | grid            |   ✓   |    ✓    |   ✓   | booking:read                               |
 *   | receivables     |   ✓   |    ✓    |   ✗   | report:read                                |
 *   | profile         |   ✓   |    ✓    |   ✓   | compliance:read OR amenity:read            |
 *   | inventory       |   ✓   |    ✓    |   ✗   | room:update                                |
 *   | guests          |   ✓   |    ✓    |   ✓   | migrationRegistration:read                 |
 *   | channels        |   ✓   |    ✓    |   ✗   | report:read                                |
 *   | tax             |   ✓   |    ✓    |   ✗   | report:read                                |
 *   | notifications   |   ✓   |    ✓    |   ✗   | notification:read                          |
 *
 *   Staff sees 3 (grid + profile + guests). Manager + owner see all 8.
 *
 * Adding a new section:
 *   1. Land the route file under `apps/frontend/src/routes/`.
 *   2. Add a row HERE in the same commit (route + sidebar entry together,
 *      per plan §4 D30 "no disabled-future").
 *   3. Update integration tests RBAC × sections matrix.
 */

import { hasPermission, type MemberRole } from '@horeca/shared'
import {
	BellIcon,
	Building2Icon,
	CalendarRangeIcon,
	FileSpreadsheetIcon,
	LayersIcon,
	type LucideIcon,
	NetworkIcon,
	UsersIcon,
	WalletIcon,
} from 'lucide-react'

/**
 * Sidebar section descriptor. `to` carries TanStack Router's `$param`
 * placeholders; `needsPropertyId` flags rows whose `to` template embeds
 * `$propertyId` and therefore requires the consumer to look up the first
 * property of the active tenant before rendering.
 */
export type SidebarSection = {
	readonly id: string
	readonly labelRu: string
	readonly ariaLabelRu: string
	readonly icon: LucideIcon
	readonly to: string
	readonly needsPropertyId?: boolean
	readonly isVisible: (role: MemberRole) => boolean
}

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = [
	{
		id: 'grid',
		labelRu: 'Шахматка',
		ariaLabelRu: 'Шахматка — занятость номеров',
		icon: CalendarRangeIcon,
		to: '/o/$orgSlug/grid',
		isVisible: (role) => hasPermission(role, { booking: ['read'] }),
	},
	{
		id: 'receivables',
		labelRu: 'Дебиторка',
		ariaLabelRu: 'Открытые счета с положительным балансом',
		icon: WalletIcon,
		to: '/o/$orgSlug/receivables',
		isVisible: (role) => hasPermission(role, { report: ['read'] }),
	},
	{
		id: 'profile',
		labelRu: 'Профиль гостиницы',
		ariaLabelRu: 'Compliance, удобства, фото, описание',
		icon: Building2Icon,
		to: '/o/$orgSlug/properties/$propertyId/content',
		needsPropertyId: true,
		// OR semantics: staff has amenity:read but not compliance:read — they
		// still see the section because the OR fans out. Plan §10.
		isVisible: (role) =>
			hasPermission(role, { compliance: ['read'] }) || hasPermission(role, { amenity: ['read'] }),
	},
	{
		id: 'inventory',
		labelRu: 'Инвентарь',
		ariaLabelRu: 'Номера, категории, тарифные планы, цены и ограничения',
		icon: LayersIcon,
		to: '/o/$orgSlug/properties/$propertyId/inventory/rooms',
		needsPropertyId: true,
		// Inventory admin = owner+manager only. Staff has room:read / ratePlan:read
		// для front-desk visibility но не управляет каталогом (canon per
		// rbac.ts staff block).
		isVisible: (role) => hasPermission(role, { room: ['update'] }),
	},
	{
		id: 'guests',
		labelRu: 'Гости',
		ariaLabelRu: 'Картотека гостей и миграционный учёт МВД',
		icon: UsersIcon,
		to: '/o/$orgSlug/admin/migration-registrations',
		isVisible: (role) => hasPermission(role, { migrationRegistration: ['read'] }),
	},
	{
		id: 'channels',
		labelRu: 'Каналы дистрибуции',
		ariaLabelRu: 'TravelLine, Яндекс.Путешествия, Ostrovok — статус подключений',
		icon: NetworkIcon,
		to: '/o/$orgSlug/admin/channels',
		isVisible: (role) => hasPermission(role, { report: ['read'] }),
	},
	{
		id: 'tax',
		labelRu: 'Туристический налог',
		ariaLabelRu: 'Квартальный отчёт по туристическому налогу 2% Сочи',
		icon: FileSpreadsheetIcon,
		to: '/o/$orgSlug/admin/tax',
		isVisible: (role) => hasPermission(role, { report: ['read'] }),
	},
	{
		id: 'notifications',
		labelRu: 'Уведомления',
		ariaLabelRu: 'История писем гостям и администрации',
		icon: BellIcon,
		to: '/o/$orgSlug/admin/notifications',
		isVisible: (role) => hasPermission(role, { notification: ['read'] }),
	},
] as const

/** Pre-computed by-id lookup for testing + dispatch by id. */
export const SIDEBAR_SECTIONS_BY_ID: Readonly<Record<string, SidebarSection>> = Object.freeze(
	Object.fromEntries(SIDEBAR_SECTIONS.map((s) => [s.id, s])),
)
