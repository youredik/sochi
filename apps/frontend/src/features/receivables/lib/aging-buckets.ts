/**
 * Aging buckets — pure helpers для receivables dashboard.
 *
 * Канонические бакеты per memory `project_horeca_domain_model.md` +
 * Apaleo conventions:
 *   - **current**: 0–7 дней с открытия фолио (норма для текущей операции)
 *   - **8to30**: 8–30 дней (мягкая просрочка, контакт с гостем)
 *   - **31to60**: 31–60 дней (средняя просрочка, эскалация)
 *   - **over60**: 60+ дней (жёсткая просрочка, юристы / списание)
 *
 * Все функции — чистые. `now` всегда инжектится явно (для тестируемости
 * и стабильного снапшота KPI на момент рендера). Ни одна функция не
 * читает `Date.now()` или `new Date()` без аргумента.
 *
 * Boundaries точные (closed-on-low / open-on-high):
 *   - daysOpen ∈ [0, 7]   → current
 *   - daysOpen ∈ [8, 30]  → 8to30
 *   - daysOpen ∈ [31, 60] → 31to60
 *   - daysOpen ∈ (60, ∞)  → over60
 */
import type { Folio } from '@horeca/shared'

export type AgingBucket = 'current' | '8to30' | '31to60' | 'over60'

export const ALL_BUCKETS: readonly AgingBucket[] = ['current', '8to30', '31to60', 'over60'] as const

/** Целое число дней между двумя ISO-датами. Окружение по UTC. */
export function daysBetween(start: string, end: Date): number {
	const startMs = new Date(start).getTime()
	const endMs = end.getTime()
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		throw new Error(`Invalid date inputs: start=${start} end=${end.toISOString()}`)
	}
	const diffDays = (endMs - startMs) / (1000 * 60 * 60 * 24)
	// `floor` не `round`: 7.9 days = ещё в bucket "current", не "8to30"
	return Math.floor(diffDays)
}

/** Бакет по числу дней. Negative days → 'current' (creator-clock skew). */
export function bucketForDays(days: number): AgingBucket {
	if (days <= 7) return 'current'
	if (days <= 30) return '8to30'
	if (days <= 60) return '31to60'
	return 'over60'
}

export interface BucketSlice {
	count: number
	amountMinor: bigint
}

export interface ReceivablesSummary {
	/** Σ balanceMinor по всем включённым folios (Int64 копейки). */
	totalOutstandingMinor: bigint
	/** Количество folios в выдаче. */
	totalCount: number
	/** Сколько просрочено (daysOpen > 7) — overdue threshold. */
	overdueCount: number
	/** Средний возраст в днях, целое — округлено к ближайшему. */
	averageDaysOutstanding: number
	/** Bucket breakdown — все 4 ключа всегда присутствуют. */
	buckets: Record<AgingBucket, BucketSlice>
}

/**
 * Aggregate folios → summary. Pure: нет skipping/filter — caller передаёт
 * уже отфильтрованный список (наш backend гарантирует balance > 0 +
 * status IN open|closed).
 */
export function summarizeReceivables(folios: Folio[], now: Date): ReceivablesSummary {
	const buckets: Record<AgingBucket, BucketSlice> = {
		current: { count: 0, amountMinor: 0n },
		'8to30': { count: 0, amountMinor: 0n },
		'31to60': { count: 0, amountMinor: 0n },
		over60: { count: 0, amountMinor: 0n },
	}
	let totalOutstandingMinor = 0n
	let overdueCount = 0
	let daysSum = 0

	for (const folio of folios) {
		const days = Math.max(0, daysBetween(folio.createdAt, now))
		const bucket = bucketForDays(days)
		const amount = BigInt(folio.balanceMinor)
		buckets[bucket].count += 1
		buckets[bucket].amountMinor += amount
		totalOutstandingMinor += amount
		daysSum += days
		if (days > 7) overdueCount += 1
	}

	const averageDaysOutstanding = folios.length === 0 ? 0 : Math.round(daysSum / folios.length)

	return {
		totalOutstandingMinor,
		totalCount: folios.length,
		overdueCount,
		averageDaysOutstanding,
		buckets,
	}
}
