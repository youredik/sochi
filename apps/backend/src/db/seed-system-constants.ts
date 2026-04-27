/**
 * Seed system_constants table with the initial set of regulatory values.
 *
 * Idempotent: re-running is safe (UPSERT). Run as part of `pnpm migrate`
 * (after `apply-migrations.ts`, before `backfill-folios.ts`).
 *
 * Each constant is paired with the law/decree that establishes it. This is
 * compliance metadata — undocumented numbers are forbidden by `feedback_no_halfway.md`.
 *
 * Source-of-truth references:
 *   - plans/research/wave4-q1q2-2026-freshness.md
 *   - plans/research/ru-compliance-2026.md
 *   - plans/research/wave4-2027-anticipated.md
 */
import { AnonymousCredentialsProvider } from '@ydbjs/auth/anonymous'
import { Driver } from '@ydbjs/core'
import { query } from '@ydbjs/query'
import { Text, Timestamp } from '@ydbjs/value/primitive'
import { dateOpt, textOpt } from './ydb-helpers.ts'

const SEED_ACTOR = 'system:seed-system-constants'

/**
 * Seed entries. Each entry MUST cite a source. yearTo=9999 means
 * «indefinitely» — applies forever until amended.
 */
type SeedEntry = {
	category: 'tax' | 'limit' | 'rate' | 'minimum' | 'compliance'
	key: string
	yearFrom: number
	yearTo: number
	data: Record<string, unknown>
	source: string
	notes: string | null
	effectiveFromDate: string | null
	effectiveToDate: string | null
}

const SEEDS: readonly SeedEntry[] = [
	// =========================================================================
	// НДС (VAT) ставки
	// =========================================================================
	{
		category: 'tax',
		key: 'vat_accommodation_rate_bps',
		yearFrom: 2025,
		yearTo: 2027,
		data: { vat_code: 5, rate_bps: 0 },
		source: 'НК ст. 164 п.3 + 67-ФЗ от 26.03.2022',
		notes:
			'Льгота 0% на гостиничные услуги. Действует до 30.06.2027. ' +
			'Продление до 31.12.2030 — анонс Минфина (поддержал), но закон не принят на 27.04.2026.',
		effectiveFromDate: '2022-07-01',
		effectiveToDate: '2027-06-30',
	},
	{
		category: 'tax',
		key: 'vat_accommodation_rate_bps',
		yearFrom: 2027, // overlap is fine — yearFrom=2027 covers H2 2027 onward
		yearTo: 9999,
		data: { vat_code: 11, rate_bps: 2200 },
		source: 'НК ст. 164 (после истечения льготы 30.06.2027)',
		notes:
			'После 30.06.2027 льгота истекает; accommodation попадает под общую ставку 22%, ' +
			'если Госдума не продлит льготу. Текущий план без продления.',
		effectiveFromDate: '2027-07-01',
		effectiveToDate: null,
	},
	{
		category: 'tax',
		key: 'vat_general_rate_bps',
		yearFrom: 2025,
		yearTo: 2025,
		data: { vat_code: 1, rate_bps: 2000 },
		source: 'НК ст. 164 (до повышения)',
		notes: 'Общая ставка НДС 20% до 31.12.2025.',
		effectiveFromDate: '2019-01-01',
		effectiveToDate: '2025-12-31',
	},
	{
		category: 'tax',
		key: 'vat_general_rate_bps',
		yearFrom: 2026,
		yearTo: 9999,
		data: { vat_code: 11, vat_code_extracted: 12, rate_bps: 2200 },
		source: '376-ФЗ от 12.07.2024',
		notes:
			'Общая ставка НДС повышена с 20% до 22% с 01.01.2026. ' +
			'vat_code 11 = 22%, vat_code 12 = 22/122 (расчётная).',
		effectiveFromDate: '2026-01-01',
		effectiveToDate: null,
	},
	// =========================================================================
	// Туристический налог Сочи (425-ФЗ + ГорСобрание №100 от 31.10.2024)
	// =========================================================================
	{
		category: 'tax',
		key: 'tourism_tax_sochi_rate_bps',
		yearFrom: 2025,
		yearTo: 2025,
		data: { rate_bps: 100 },
		source: 'Решение ГорСобрания Sochi №100 от 31.10.2024',
		notes: '1% в 2025 (первый год эксперимента).',
		effectiveFromDate: '2025-01-01',
		effectiveToDate: '2025-12-31',
	},
	{
		category: 'tax',
		key: 'tourism_tax_sochi_rate_bps',
		yearFrom: 2026,
		yearTo: 2026,
		data: { rate_bps: 200 },
		source: 'Решение ГорСобрания Sochi №100 от 31.10.2024',
		notes: '2% в 2026.',
		effectiveFromDate: '2026-01-01',
		effectiveToDate: '2026-12-31',
	},
	{
		category: 'tax',
		key: 'tourism_tax_sochi_rate_bps',
		yearFrom: 2027,
		yearTo: 2027,
		data: { rate_bps: 300 },
		source: 'Решение ГорСобрания Sochi №100 от 31.10.2024',
		notes:
			'3% в 2027 (по федеральной траектории 425-ФЗ +1%/год). ' +
			'Конкретное муниципальное решение на 2027 ожидается осенью 2026.',
		effectiveFromDate: '2027-01-01',
		effectiveToDate: '2027-12-31',
	},
	{
		category: 'tax',
		key: 'tourism_tax_sochi_rate_bps',
		yearFrom: 2028,
		yearTo: 2028,
		data: { rate_bps: 400 },
		source: 'Решение ГорСобрания Sochi №100 от 31.10.2024',
		notes: '4% в 2028.',
		effectiveFromDate: '2028-01-01',
		effectiveToDate: '2028-12-31',
	},
	{
		category: 'tax',
		key: 'tourism_tax_sochi_rate_bps',
		yearFrom: 2029,
		yearTo: 9999,
		data: { rate_bps: 500 },
		source: 'Решение ГорСобрания Sochi №100 от 31.10.2024',
		notes: '5% в 2029 (max по 425-ФЗ).',
		effectiveFromDate: '2029-01-01',
		effectiveToDate: null,
	},
	{
		category: 'minimum',
		key: 'tourism_tax_min_per_night_kop',
		yearFrom: 2025,
		yearTo: 9999,
		data: { kop: 10000 }, // 100 ₽
		source: '425-ФЗ ст. 418.7',
		notes:
			'Фиксированный минимум 100₽/сутки за номер. НЕ индексируется автоматически — ' +
			'требует поправки в НК для изменения. Обсуждается в Госдуме индексация на инфляцию (не принято).',
		effectiveFromDate: '2025-01-01',
		effectiveToDate: null,
	},
	// =========================================================================
	// Лимиты налоговых режимов
	// =========================================================================
	{
		category: 'limit',
		key: 'npd_self_employed_annual_limit_kop',
		yearFrom: 2025,
		yearTo: 2025,
		data: { kop: 360_000_000 }, // 3.6 млн ₽
		source: '422-ФЗ + изменения',
		notes: 'НПД (самозанятые) лимит 3.6 млн ₽/год в 2025.',
		effectiveFromDate: '2025-01-01',
		effectiveToDate: '2025-12-31',
	},
	{
		category: 'limit',
		key: 'npd_self_employed_annual_limit_kop',
		yearFrom: 2026,
		yearTo: 2026,
		data: { kop: 380_000_000 }, // 3.8 млн ₽
		source: '422-ФЗ + изменения',
		notes: 'НПД лимит 3.8 млн ₽/год в 2026.',
		effectiveFromDate: '2026-01-01',
		effectiveToDate: '2026-12-31',
	},
	{
		category: 'limit',
		key: 'npd_self_employed_annual_limit_kop',
		yearFrom: 2027,
		yearTo: 2027,
		data: { kop: 400_000_000 }, // 4.0 млн ₽
		source: '422-ФЗ + изменения',
		notes: 'НПД лимит 4.0 млн ₽/год в 2027.',
		effectiveFromDate: '2027-01-01',
		effectiveToDate: '2027-12-31',
	},
	{
		category: 'limit',
		key: 'npd_self_employed_annual_limit_kop',
		yearFrom: 2028,
		yearTo: 2028,
		data: { kop: 420_000_000 }, // 4.2 млн ₽
		source: '422-ФЗ + изменения',
		notes:
			'НПД лимит 4.2 млн ₽/год в 2028 (последний год эксперимента 422-ФЗ; ' +
			'продление до 31.12.2028 confirmed, после 2028 — пересмотр режима).',
		effectiveFromDate: '2028-01-01',
		effectiveToDate: '2028-12-31',
	},
	{
		category: 'limit',
		key: 'usn_vat_threshold_kop',
		yearFrom: 2025,
		yearTo: 9999,
		data: { kop: 6_000_000_000 }, // 60 млн ₽
		source: '376-ФЗ от 12.07.2024',
		notes:
			'Порог освобождения УСН от НДС-обязанности = 60 млн ₽/год. ' +
			'Снижение до 15 млн (2027) и 10 млн (2028) — упоминается в research, ' +
			'НО не подтверждено в опубликованной редакции 376-ФЗ на 27.04.2026. ' +
			'WebFetch верификация на pravo.gov.ru обязательна перед финализацией M9.',
		effectiveFromDate: '2025-01-01',
		effectiveToDate: null,
	},
	// =========================================================================
	// Compliance
	// =========================================================================
	{
		category: 'compliance',
		key: 'ksr_registry_required',
		yearFrom: 2025,
		yearTo: 9999,
		data: { required: true, registryUrl: 'classification.tourism.gov.ru', deadline: '2025-09-01' },
		source: 'ПП РФ № 1951 от 27.12.2024',
		notes:
			'Обязательная регистрация всех средств размещения в Едином реестре КСР до 01.09.2025. ' +
			'Без записи запрещено оказывать услуги. Штраф 300-450к ₽ (КоАП 14.39).',
		effectiveFromDate: '2025-09-01',
		effectiveToDate: null,
	},
	{
		category: 'compliance',
		key: 'guest_house_experiment',
		yearFrom: 2025,
		yearTo: 2027,
		data: {
			law: 'ФЗ-127 от 07.06.2025',
			classification: 'ПП №1345 от 30.08.2025',
			regions: ['krasnodarskiy_kray', 'altay', 'dagestan', 'kaliningrad', 'crimea', 'spb'],
			limits: { maxRooms: 15, maxGuests: 45 },
		},
		source: 'ФЗ-127 от 07.06.2025 + ПП №1345 от 30.08.2025',
		notes:
			'Эксперимент по гостевым домам 01.09.2025 — 31.12.2027. ' +
			'Краснодарский край (включая Сочи) в перечне. Лимиты ≤15 номеров, ≤45 гостей.',
		effectiveFromDate: '2025-09-01',
		effectiveToDate: '2027-12-31',
	},
	{
		category: 'compliance',
		key: 'pp_1912_effective',
		yearFrom: 2026,
		yearTo: 9999,
		data: {
			law: 'ПП РФ №1912 от 27.11.2025',
			pp_1853_voided: '2026-03-01',
			pp_174_amendment: '2026-02-21',
			rules: {
				cancellationPolicy: 'all_refundable',
				noShowCapNights: 1,
				holdUntilHourLocal: '12:00',
			},
		},
		source: 'ПП РФ №1912 от 27.11.2025 + ПП-174 от 21.02.2026',
		notes:
			'С 01.03.2026 новые правила гостиничных услуг. ПП-1853 утратило силу. ' +
			'B2C: все бронирования возвратные, no-show cap = 1 ночь, hold до 12:00 след. дня.',
		effectiveFromDate: '2026-03-01',
		effectiveToDate: null,
	},
]

async function main(): Promise<void> {
	const connStr = process.env.YDB_CONNECTION_STRING ?? 'grpc://localhost:2236/local'
	const driver = new Driver(connStr, {
		credentialsProvider: new AnonymousCredentialsProvider(),
	})
	await driver.ready(AbortSignal.timeout(30_000))
	const sql = query(driver)

	// Application-level invariant: non-overlapping yearFrom ranges per (category,key)
	// EXCEPT explicit yearTo=2027 followed by yearFrom=2027 (split-year boundary
	// for льгота-до-30.06.2027 cases). We allow the overlap because the
	// underlying range queries use inclusive bounds and the data column
	// disambiguates by `effectiveFromDate`/`effectiveToDate`.
	validateNonOverlap(SEEDS)

	const now = new Date()
	let upsertCount = 0
	for (const s of SEEDS) {
		await sql`
			UPSERT INTO systemConstant (
				category, key, yearFrom, yearTo, data, source, notes,
				effectiveFromDate, effectiveToDate,
				createdAt, createdBy, updatedAt, updatedBy
			) VALUES (
				${new Text(s.category)},
				${new Text(s.key)},
				${s.yearFrom},
				${s.yearTo},
				${new Text(JSON.stringify(s.data))},
				${new Text(s.source)},
				${textOpt(s.notes)},
				${dateOpt(s.effectiveFromDate)},
				${dateOpt(s.effectiveToDate)},
				${new Timestamp(now)},
				${new Text(SEED_ACTOR)},
				${new Timestamp(now)},
				${new Text(SEED_ACTOR)}
			)
		`.idempotent(true)
		upsertCount += 1
	}
	console.log(`✅ system_constants seeded: ${upsertCount} rows upserted`)
	await driver.close()
}

/**
 * Each (category, key) must have a contiguous, non-overlapping coverage of
 * years (with the documented split-year exception). Throws on violation.
 */
export function validateNonOverlap(seeds: readonly SeedEntry[]): void {
	const byKey = new Map<string, SeedEntry[]>()
	for (const s of seeds) {
		const k = `${s.category}::${s.key}`
		const list = byKey.get(k) ?? []
		list.push(s)
		byKey.set(k, list)
	}
	for (const [k, list] of byKey) {
		list.sort((a, b) => a.yearFrom - b.yearFrom)
		for (let i = 1; i < list.length; i++) {
			const prev = list[i - 1]
			const curr = list[i]
			if (prev === undefined || curr === undefined) continue
			// Allowed: prev.yearTo == curr.yearFrom (split-year boundary).
			// Disallowed: prev.yearTo > curr.yearFrom (overlap), or
			//             prev.yearTo + 1 < curr.yearFrom (gap).
			if (prev.yearTo > curr.yearFrom) {
				throw new Error(
					`system_constants overlap for ${k}: ` +
						`[${prev.yearFrom}..${prev.yearTo}] overlaps [${curr.yearFrom}..${curr.yearTo}]`,
				)
			}
			if (prev.yearTo + 1 < curr.yearFrom) {
				throw new Error(
					`system_constants gap for ${k}: ` +
						`[${prev.yearFrom}..${prev.yearTo}] then [${curr.yearFrom}..${curr.yearTo}] (year ${prev.yearTo + 1} missing)`,
				)
			}
		}
	}
}

const isCliEntry =
	typeof process !== 'undefined' && process.argv[1]?.includes('seed-system-constants')
if (isCliEntry) {
	main().catch((err) => {
		console.error('❌ seed-system-constants failed:', err)
		process.exit(1)
	})
}
