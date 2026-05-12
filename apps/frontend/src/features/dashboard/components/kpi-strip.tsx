/**
 * KpiStrip — top metric strip composed из 4 KpiCard tiles.
 *
 * Data sourcing (per `use-dashboard-data.ts`):
 *   - bookingsWindow (32d) — feeds Заезды сегодня + В отеле
 *   - receivables — feeds Открытый баланс
 *   - failedNotifications — feeds Письма со сбоем
 *
 * RBAC gates (per `packages/shared/src/rbac.ts` verified 2026-05-12):
 *   - Заезды сегодня + В отеле   — `booking:read` (all 3 roles)
 *   - Открытый баланс             — `report:read` (owner+manager)
 *   - Письма со сбоем             — `notification:read` (owner+manager)
 *
 * Card rendered "hidden" если permission missing — staff sees 2 cards,
 * owner+manager sees 4. Per `feedback_no_halfway.md` no half-renders: card
 * absent (NOT disabled-with-fake-data) when out of scope.
 *
 * State derivation per card (Loading | Error | Value):
 *   - useQuery `isLoading` → state.loading
 *   - useQuery `isError` → state.error (canonical "Не удалось загрузить")
 *   - else → state.value (computed via `compute-kpis.ts`)
 *
 * Plan deviation note (POST-AUDIT C38, see plan §17):
 *   Plan §7 row 3 wrote "Occupancy / ADR / RevPAR placeholders". Replaced
 *   per `project_dashboard_external.md` canon (3.1 KPI = DataLens external,
 *   NOT our code) + R1 research 2026-05-12 (Cloudbeds/Mews operator dashboard
 *   = tactical-today). Tactical-today gives operator real numbers сразу
 *   instead of "—" placeholders that never get data.
 */
import { hasPermission, type MemberRole } from '@horeca/shared'
import { useQuery } from '@tanstack/react-query'
import { formatMoney, formatMoneyA11y } from '../../../lib/format-ru.ts'
import { receivablesQueryOptions } from '../../receivables/hooks/use-receivables.ts'
import {
	countArrivalsToday,
	countFailedNotifications,
	countInHouseNow,
	sumOpenBalanceMinor,
	todayInMoscow,
} from '../lib/compute-kpis.ts'
import {
	bookingsWindowQueryOptions,
	failedNotificationsQueryOptions,
} from '../lib/use-dashboard-data.ts'
import { KpiCard, type KpiCardState } from './kpi-card.tsx'

export type KpiStripProps = {
	readonly memberRole: MemberRole | undefined
	readonly propertyId: string
}

const ERROR_LOAD_RU = 'Не удалось загрузить'

export function KpiStrip({ memberRole, propertyId }: KpiStripProps) {
	const bookings = useQuery(bookingsWindowQueryOptions(propertyId))
	const receivables = useQuery(receivablesQueryOptions(propertyId))
	const failed = useQuery(failedNotificationsQueryOptions)

	const today = todayInMoscow()

	// Per RBAC (deny-by-default: memberRole undefined → no permission).
	const canBooking = memberRole !== undefined && hasPermission(memberRole, { booking: ['read'] })
	const canReports = memberRole !== undefined && hasPermission(memberRole, { report: ['read'] })
	const canNotifications =
		memberRole !== undefined && hasPermission(memberRole, { notification: ['read'] })

	function arrivalsState(): KpiCardState {
		if (bookings.isPending) return { kind: 'loading' }
		if (bookings.isError) return { kind: 'error', message: ERROR_LOAD_RU }
		const count = countArrivalsToday(bookings.data ?? [], today)
		return { kind: 'value', value: String(count) }
	}

	function inHouseState(): KpiCardState {
		if (bookings.isPending) return { kind: 'loading' }
		if (bookings.isError) return { kind: 'error', message: ERROR_LOAD_RU }
		const count = countInHouseNow(bookings.data ?? [])
		return { kind: 'value', value: String(count) }
	}

	function balanceState(): KpiCardState {
		if (receivables.isPending) return { kind: 'loading' }
		if (receivables.isError) return { kind: 'error', message: ERROR_LOAD_RU }
		const totalKop = sumOpenBalanceMinor(receivables.data ?? [])
		return {
			kind: 'value',
			value: formatMoney(totalKop),
			ariaValue: formatMoneyA11y(totalKop),
		}
	}

	function failedState(): KpiCardState {
		if (failed.isPending) return { kind: 'loading' }
		if (failed.isError) return { kind: 'error', message: ERROR_LOAD_RU }
		const count = countFailedNotifications(failed.data ?? [])
		return { kind: 'value', value: String(count) }
	}

	return (
		<section
			aria-label="Ключевые показатели"
			data-dashboard-section="kpi-strip"
			className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
		>
			{canBooking ? (
				<KpiCard
					slug="arrivals-today"
					title="Заезды сегодня"
					state={arrivalsState()}
					footnote="за сегодня"
				/>
			) : null}
			{canBooking ? (
				<KpiCard slug="in-house" title="В отеле" state={inHouseState()} footnote="сейчас" />
			) : null}
			{canReports ? (
				<KpiCard
					slug="open-balance"
					title="Открытый баланс"
					state={balanceState()}
					footnote="дебиторская задолженность"
				/>
			) : null}
			{canNotifications ? (
				<KpiCard
					slug="failed-notifications"
					title="Письма со сбоем"
					state={failedState()}
					footnote="требуют повторной отправки"
				/>
			) : null}
		</section>
	)
}
