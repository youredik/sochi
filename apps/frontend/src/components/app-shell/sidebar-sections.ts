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
 *   | reviews         |   ✓   |    ✓    |   ✗   | review:read                                |
 *   | channels        |   ✓   |    ✓    |   ✗   | report:read                                |
 *   | tax             |   ✓   |    ✓    |   ✗   | report:read                                |
 *   | notifications   |   ✓   |    ✓    |   ✗   | notification:read                          |
 *   | demo            |   ✓   |    ✓    |   ✗   | room:update                                |
 *
 *   Staff sees 3 (grid + profile + guests). Manager + owner see all 10.
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
	MessageSquareTextIcon,
	NetworkIcon,
	SparklesIcon,
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
	/**
	 * If true, sidebar entry stays active for any URL prefix-matching `to`.
	 * Use for sections с sub-tabs (e.g. `inventory` has `/rooms` / `/rate-
	 * plans` / `/prices` tabs — all should highlight the parent menu item).
	 * Defaults к false (`activeOptions={{ exact: true }}` per A.bis.2 D22).
	 */
	readonly activeOnPrefix?: boolean
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
		// `to` points к the parent layout — its beforeLoad redirects к /rooms
		// by default. Sub-tab siblings (/rooms / /rate-plans / /prices) all
		// live under /inventory, so `activeOnPrefix=true` + Link `exact:false`
		// highlights the menu entry across all three. Pointing `to` at a leaf
		// would only highlight on that one tab (children-only relation).
		to: '/o/$orgSlug/properties/$propertyId/inventory',
		needsPropertyId: true,
		activeOnPrefix: true,
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
		// AI review-reply (2026-05-30) — отзывы из каналов + ИИ-ответ (YandexGPT).
		// owner+manager (guest-comms + публичный ответ от лица объекта); staff
		// не видит — тот же predicate-класс что report / channels.
		id: 'reviews',
		labelRu: 'Отзывы',
		ariaLabelRu: 'Отзывы гостей из каналов и ИИ-ответы',
		icon: MessageSquareTextIcon,
		to: '/o/$orgSlug/reviews',
		isVisible: (role) => hasPermission(role, { review: ['read'] }),
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
	{
		// Round 14.6 — per-tenant demo OTA в кабинете. Каждый отель видит
		// свою копию демо OTA façade (YT + ETG mocks) + свою шахматку справа.
		// Visibility = owner+manager only (staff не нужен demo инструмент;
		// тот же RBAC predicate как inventory — `room:update`).
		id: 'demo',
		labelRu: 'Демо OTA',
		ariaLabelRu: 'Демо-интеграции с Яндекс.Путешествия и Островком — Sandbox для тренинга команды',
		icon: SparklesIcon,
		to: '/o/$orgSlug/demo',
		isVisible: (role) => hasPermission(role, { room: ['update'] }),
	},
] as const

/** Pre-computed by-id lookup for testing + dispatch by id. */
export const SIDEBAR_SECTIONS_BY_ID: Readonly<Record<string, SidebarSection>> = Object.freeze(
	Object.fromEntries(SIDEBAR_SECTIONS.map((s) => [s.id, s])),
)
