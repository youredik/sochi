/**
 * Tenant compliance — RU regulatory metadata required to legally operate
 * a property.
 *
 * Schema lives on `organizationProfile` (1:1 with `organization`). Wired into
 * onboarding wizard в M8.A.0.6; stored nullable so existing orgs keep working
 * until their owner completes the new wizard step.
 *
 * Sources (research/ru-compliance-2026.md):
 *   - **ПП-1951 от 18.11.2020 (с поправками 2025)** — Реестр КСР обязателен;
 *     штраф 300-450к ₽ за работу без записи (проверка через классификацию КСР).
 *   - **ПП-1912 от 27.11.2025** — действующая категоризация КСР с 01.03.2026
 *     (отменяет ПП-1853 + ПП-1860).
 *   - **ФЗ-127 от 07.06.2025 + ПП-1345 от 30.08.2025** — закон о гостевых
 *     домах, эксперимент с 01.09.2025.
 *   - **376-ФЗ от 12.07.2025** — НДС 22% с 01.01.2026; УСН 60М порог.
 *   - **425-ФЗ от 30.10.2025** — НПД лимиты 3.6M (2025) → 3.8M (2026)
 *     → 4.0M (2027) → 4.2M (2028).
 *
 * Validated at service boundary (Hono routes + better-auth org hook).
 */
import { z } from 'zod'
import { int64WireSchema } from './schemas.ts'

/**
 * Категория КСР по ПП-1912 от 27.11.2025 (в силе с 01.03.2026).
 * Список соответствует заявке на классификацию через Госуслуги/региональные
 * органы.
 */
export const ksrCategoryValues = [
	'hotel',
	'aparthotel',
	'mini_hotel',
	'guest_house',
	'sanatorium',
	'rest_house',
	'hostel',
	'camping',
	'tourist_center',
	'recreation_complex',
	'other',
] as const
export const ksrCategorySchema = z.enum(ksrCategoryValues)
export type KsrCategory = z.infer<typeof ksrCategorySchema>

/**
 * Организационно-правовая форма. NPD — самозанятый (физлицо в режиме НПД,
 * без регистрации ИП).
 */
export const legalEntityTypeValues = ['ip', 'ooo', 'ao', 'npd', 'other'] as const
export const legalEntityTypeSchema = z.enum(legalEntityTypeValues)
export type LegalEntityType = z.infer<typeof legalEntityTypeSchema>

/**
 * Налоговый режим. AUSN — автоматизированная упрощёнка (с 2022, для до 60
 * сотрудников). PSN — патент. OSN — общая система. NPD — налог на
 * профессиональный доход (самозанятые).
 */
export const taxRegimeValues = [
	'NPD',
	'USN_DOHODY',
	'USN_DOHODY_RASHODY',
	'PSN',
	'OSN',
	'AUSN_DOHODY',
	'AUSN_DOHODY_RASHODY',
	// `UNKNOWN` — DaData / onboarding sources rarely surface a tax-regime value,
	// и форсировать пользователя выбрать его одновременно с ИНН-lookup ломает
	// поток. Хранится как-есть до момента когда compliance-форма дозаполнит.
	'UNKNOWN',
] as const
export const taxRegimeSchema = z.enum(taxRegimeValues)
export type TaxRegime = z.infer<typeof taxRegimeSchema>

/**
 * РФ-выручка прошедшего/планового года в micro-RUB (1 ₽ = 1_000_000 micros).
 *
 * Зачем micro: единицы согласованы с remainder of the codebase (`totalMicros`
 * / `paidMicros` / `accommodationMicros` / тур. налог). Конвертация UI ↔ DB
 * через единый helper `format-ru.ts`.
 *
 * Bounds: [0, 100_000_000_000_000_000] ≈ 100 трлн ₽ — sanity, не реальный
 * предел (Int64 хватит до ~9.2 × 10^18).
 *
 * Используется для:
 *   - **УСН 60M ₽ порог 2026** (376-ФЗ): warn при revenue ≥ 60_000_000_000_000.
 *   - **УСН-НДС 30M ₽ порог 2027** (anticipated): warn при ≥ 30M.
 *   - **НПД 3.8M ₽ лимит 2026** (425-ФЗ): warn при ≥ 3_800_000_000_000.
 *   - **PSN 60M ₽ лимит**: warn при ≥ 60M.
 *
 * Все warn-thresholds — на app-уровне (advisory), НЕ enforce'им; оператор
 * сам выбирает режим. Threshold values читаются из system_constants (M8.0).
 */
/**
 * Accepts both wire form (`string`) and bigint. JSON wire-format is string
 * because `JSON.stringify(bigint)` throws — so frontend sends `"100"` and
 * server-side service calls pass `100n` directly. Both coerce to bigint.
 */
export const annualRevenueEstimateMicroRubSchema = int64WireSchema
	.refine((v) => v >= 0n, 'Revenue must be >= 0')
	.refine((v) => v <= 100_000_000_000_000_000n, 'Revenue exceeds sanity bound (100 trillion ₽)')

/**
 * Реестр КСР id — реестровый номер из ФГИС «Гостеприимство» (Росаккредитация).
 *
 * Canon Q2 2026 (ПП-1951 от 27.12.2024 ред. 27.11.2025, effective 01.09.2025):
 *   Format `^С\d{12}$` (Cyrillic С + 12 digits, e.g. `С782031059672`).
 *   Источник истины — tourism.fsa.gov.ru ЛК отеля после самооценки.
 *
 * **Soft validation** here: regex applied via `.refine` warning, NOT strict
 * reject. Existing tenant profiles могут хранить legacy free-form data из
 * прежнего канона ПП-1912. Hard-gate в booking.service.create только проверяет
 * non-empty. UI form validates strict format при NEW input.
 */
const KSR_REGISTRY_NUMBER_REGEX = /^С\d{12}$/
export const ksrRegistryIdSchema = z
	.string()
	.min(1)
	.max(50)
	.refine(
		(v) => KSR_REGISTRY_NUMBER_REGEX.test(v),
		'Формат реестрового номера: С + 12 цифр (например С782031059672). Cyrillic С (русская буква).',
	)

/**
 * Полный compliance-блок профиля. Все поля nullable — заполняются поэтапно
 * через wizard. Repo принимает partial-patch.
 */
/**
 * Sprint C+ Senior P1-5 + Legal audit 2026-05-23d: 152-ФЗ ст.9 ч.4 mandates
 * `наименование или ФИО + адрес оператора` in consent text. legalAddress
 * captured here. dpoEmail recommended by РКН practice (ст.22.1 contact для
 * РКН notification — not mandatory in consent text per Legal expert verdict,
 * но defensible best-practice).
 *
 * `inn` already lives on organizationProfile (migration 0001) — not added here
 * because it's read directly от organizationProfile, not via compliance shape.
 */
export const legalAddressSchema = z.string().min(5).max(500)
export const dpoEmailSchema = z.string().email().max(200)
/**
 * Sprint C+ Round 6 Legal P0 fix 2026-05-24 — 152-ФЗ ст.22 ч.3 п.7.1
 * (verbatim): «фамилия, имя, отчество физического лица или наименование
 * юридического лица, ответственного за организацию обработки персональных
 * данных, и номера их контактных телефонов, почтовые адреса и адреса
 * электронной почты». Email одного field недостаточно — добавлены ФИО, phone,
 * postal address. РКН ст.22.1 + practice 2026.
 */
export const dpoFullNameSchema = z.string().min(3).max(200)
// RU national либо E.164 international (`+79991234567` или `7999123456` etc.).
// Min 7 digits после format strip, max 20 chars raw.
export const dpoPhoneSchema = z
	.string()
	.min(7)
	.max(20)
	.refine(
		(v) => /^[\d+()\s-]+$/.test(v) && v.replace(/[^\d]/g, '').length >= 7,
		'Формат телефона: +7 999 123-45-67 либо 79991234567 (минимум 7 цифр)',
	)
export const dpoPostalAddressSchema = z.string().min(5).max(500)

export const tenantComplianceSchema = z.object({
	ksrRegistryId: ksrRegistryIdSchema.nullable(),
	ksrCategory: ksrCategorySchema.nullable(),
	legalEntityType: legalEntityTypeSchema.nullable(),
	taxRegime: taxRegimeSchema.nullable(),
	annualRevenueEstimateMicroRub: annualRevenueEstimateMicroRubSchema.nullable(),
	guestHouseFz127Registered: z.boolean().nullable(),
	ksrVerifiedAt: z.string().datetime().nullable(),
	legalAddress: legalAddressSchema.nullable(),
	dpoEmail: dpoEmailSchema.nullable(),
	// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — 152-ФЗ ст.22 ч.3 п.7.1 full DPO contact.
	dpoFullName: dpoFullNameSchema.nullable(),
	dpoPhone: dpoPhoneSchema.nullable(),
	dpoPostalAddress: dpoPostalAddressSchema.nullable(),
})
export type TenantCompliance = z.infer<typeof tenantComplianceSchema>

/**
 * Patch input — все поля optional+nullable, минимум одно поле должно быть
 * передано. `null` явно сбрасывает значение, `undefined` оставляет
 * существующее (классический three-state patch).
 */
export const tenantCompliancePatchSchema = z
	.object({
		ksrRegistryId: ksrRegistryIdSchema.nullable().optional(),
		ksrCategory: ksrCategorySchema.nullable().optional(),
		legalEntityType: legalEntityTypeSchema.nullable().optional(),
		taxRegime: taxRegimeSchema.nullable().optional(),
		annualRevenueEstimateMicroRub: annualRevenueEstimateMicroRubSchema.nullable().optional(),
		guestHouseFz127Registered: z.boolean().nullable().optional(),
		ksrVerifiedAt: z.string().datetime().nullable().optional(),
		// Sprint C+ Senior P1-5 fix 2026-05-23d: 152-ФЗ ст.9 ч.4 operator identity.
		legalAddress: legalAddressSchema.nullable().optional(),
		dpoEmail: dpoEmailSchema.nullable().optional(),
		// Sprint C+ Round 6 Legal P0 fix 2026-05-24 — 152-ФЗ ст.22 ч.3 п.7.1 full DPO contact.
		dpoFullName: dpoFullNameSchema.nullable().optional(),
		dpoPhone: dpoPhoneSchema.nullable().optional(),
		dpoPostalAddress: dpoPostalAddressSchema.nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type TenantCompliancePatch = z.infer<typeof tenantCompliancePatchSchema>

/**
 * Cross-field invariant: гостевые дома (ksrCategory='guest_house') обязаны
 * подтвердить участие в эксперименте ФЗ-127 (true / false) — null недопустим
 * для этой категории. Для всех остальных категорий поле должно быть null.
 *
 * Применяется через .refine на patch при completion onboarding wizard
 * (НЕ на каждом patch — иначе нельзя последовательно заполнять поля).
 *
 * Returns null → invariant satisfied; string → human-readable error.
 */
export function checkGuestHouseInvariant(c: {
	readonly ksrCategory: KsrCategory | null
	readonly guestHouseFz127Registered: boolean | null
}): string | null {
	if (c.ksrCategory === 'guest_house' && c.guestHouseFz127Registered === null) {
		return 'Для гостевых домов обязательно указать участие в эксперименте ФЗ-127 (ПП-1345)'
	}
	if (c.ksrCategory !== 'guest_house' && c.guestHouseFz127Registered !== null) {
		return 'Поле «эксперимент ФЗ-127» применимо только к категории guest_house'
	}
	return null
}

/**
 * Cross-field invariant: НПД-режим доступен ТОЛЬКО для legalEntityType='npd'
 * (самозанятых) и наоборот — ИП/ООО/АО не могут быть на НПД. Закрывает
 * частую ошибку оператора при заполнении wizard.
 */
export function checkTaxRegimeInvariant(c: {
	readonly legalEntityType: LegalEntityType | null
	readonly taxRegime: TaxRegime | null
}): string | null {
	if (c.legalEntityType === null || c.taxRegime === null) return null
	if (c.legalEntityType === 'npd' && c.taxRegime !== 'NPD') {
		return 'Самозанятый (НПД) может применять только режим NPD'
	}
	if (c.legalEntityType !== 'npd' && c.taxRegime === 'NPD') {
		return 'Режим NPD доступен только для legalEntityType=npd (самозанятый)'
	}
	if (c.legalEntityType === 'ip' && c.taxRegime === 'AUSN_DOHODY_RASHODY') {
		// АУСН для ИП — только AUSN_DOHODY (без вычета расходов).
		return 'ИП на АУСН могут применять только AUSN_DOHODY (доходы)'
	}
	return null
}

/**
 * УСН 60M ₽ порог за 2026 (376-ФЗ). Возвращает true если оператору следует
 * показать предупреждение «вы близки к порогу — рассмотрите ОСН».
 *
 * Threshold value — это hardcode для удобства unit-тестов; production-код
 * читает из `systemConstant` (category='limit', key='usn_threshold').
 */
export const USN_THRESHOLD_2026_MICRO_RUB = 60_000_000_000_000n

export function isUsnThresholdAtRisk(annualRevenueMicroRub: bigint | null): boolean {
	if (annualRevenueMicroRub === null) return false
	// 80% от порога — точка тревоги (стандартная UX-практика).
	return annualRevenueMicroRub >= (USN_THRESHOLD_2026_MICRO_RUB * 80n) / 100n
}

/**
 * НПД 3.8M ₽ лимит за 2026 (425-ФЗ от 30.10.2025). Жёсткий предел —
 * самозанятый ОБЯЗАН перейти на ИП/ООО при превышении.
 */
export const NPD_LIMIT_2026_MICRO_RUB = 3_800_000_000_000n

export function isNpdLimitExceeded(annualRevenueMicroRub: bigint | null): boolean {
	if (annualRevenueMicroRub === null) return false
	return annualRevenueMicroRub >= NPD_LIMIT_2026_MICRO_RUB
}
