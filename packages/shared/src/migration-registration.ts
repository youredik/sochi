/**
 * Migration registration (ЕПГУ submission) — shared schema between
 * backend (Hono routes + Zod validation) and frontend (TanStack Query
 * types + RBAC button gates).
 *
 * Closes (per project_initial_framing.md mandate):
 *   - 1.1 Госуслуги (Скала-ЕПГУ) — миграционный учёт через API ЕПГУ
 *
 * References:
 *   - plans/research/epgu-rkl.md — canonical FSM + 8 error categories
 *   - apps/backend/src/db/migrations/0035_migration_registration.sql
 *   - apps/backend/src/domains/epgu/transport/types.ts (EpguTransport)
 */
import { z } from 'zod'

/**
 * ПП-174 (с 01.03.2026) identity_method enum — 5 values per новой
 * редакции Постановления Правительства о порядке миграционного учёта.
 */
export const identityMethodValues = [
	'passport_paper', // паспорт РФ бумажный
	'passport_zagran', // заграничный паспорт
	'driver_license', // водительское удостоверение (для граждан РФ)
	'ebs', // ЕБС (Единая Биометрическая Система)
	'digital_id_max', // Цифровой ID через приложение «МАX»
] as const
export const identityMethodSchema = z.enum(identityMethodValues)
export type IdentityMethod = z.infer<typeof identityMethodSchema>

/**
 * 8 error categories per research/epgu-rkl.md §4 — classification
 * of statusCode=4 (refused) reasons for analytics + retry policy.
 */
export const epguErrorCategoryValues = [
	'validation_format', // ФЛК (формально-логический контроль)
	'signature_invalid', // ГОСТ Р 34.10-2012 cert
	'duplicate_notification', // дубликат
	'document_lost_or_invalid', // паспорт утрачен
	'rkl_match', // в РКЛ
	'region_mismatch', // регион не совпадает
	'stay_period_exceeded', // > 90/180 дней
	'service_temporarily_unavailable', // 503 + Retry-After
] as const
export const epguErrorCategorySchema = z.enum(epguErrorCategoryValues)
export type EpguErrorCategory = z.infer<typeof epguErrorCategorySchema>

/**
 * EPGU canonical status codes (mirror types.ts EpguStatusResponse):
 *   0  — draft (не отправлено)
 *   1  — registered (после СМЭВ)
 *   2  — sent_to_authority
 *   3  — executed [FINAL]
 *   4  — refused [FINAL]
 *   5  — send_error
 *   9  — cancellation_pending
 *   10 — cancelled [FINAL]
 *   14 — awaiting_info
 *   15 — requires_correction
 *   17 — submitted (sync ack)
 *   21 — acknowledged (промежуточный)
 *   22 — delivery_error
 *   24 — processing_error
 */
export const EPGU_STATUS_CODES = {
	draft: 0,
	registered: 1,
	sent_to_authority: 2,
	executed: 3,
	refused: 4,
	send_error: 5,
	cancellation_pending: 9,
	cancelled: 10,
	awaiting_info: 14,
	requires_correction: 15,
	submitted: 17,
	acknowledged: 21,
	delivery_error: 22,
	processing_error: 24,
} as const

export const EPGU_FINAL_STATUS_CODES: ReadonlySet<number> = new Set([
	EPGU_STATUS_CODES.executed,
	EPGU_STATUS_CODES.refused,
	EPGU_STATUS_CODES.cancelled,
])

export function isEpguFinalStatus(statusCode: number): boolean {
	return EPGU_FINAL_STATUS_CODES.has(statusCode)
}

/**
 * Pretty-print status code for UI badge.
 */
export const EPGU_STATUS_LABELS_RU: Record<number, string> = {
	0: 'Черновик',
	1: 'Принято от заявителя',
	2: 'Отправлено в ведомство',
	3: 'Исполнено',
	4: 'Отказ',
	5: 'Ошибка отправки',
	9: 'Запрошено снятие',
	10: 'Снято с учёта',
	14: 'Запрос уточнений',
	15: 'Требуется исправление',
	17: 'Подано',
	21: 'Подтверждено',
	22: 'Ошибка доставки',
	24: 'Ошибка обработки',
}

export const EPGU_CHANNEL_VALUES = ['gost-tls', 'svoks', 'proxy-via-partner'] as const
export const epguChannelSchema = z.enum(EPGU_CHANNEL_VALUES)
export type EpguChannel = z.infer<typeof epguChannelSchema>

/**
 * ЕПГУ service identifiers — global per service-type (NOT tenant-specific).
 *
 * `EPGU_SERVICE_CODE_MIGRATION_REGISTRATION` — постановка ИГ на миграционный
 * учёт (Постановление №1668). Все средства размещения отправляют под этим
 * service code.
 *
 * `EPGU_TARGET_CODE_MIGRATION_REGISTRATION` — целевая ситуация в ЕПГУ
 * (sub-service identifier).
 *
 * Source: research/epgu-rkl.md §2 + Скала-ЕПГУ public spec. Verified
 * empirically через MockEpguTransport.test.ts fixtures (одинаковые значения
 * как в production).
 */
export const EPGU_SERVICE_CODE_MIGRATION_REGISTRATION = '10000103652'
export const EPGU_TARGET_CODE_MIGRATION_REGISTRATION = '-1000444103652'

/**
 * Migration registration row schema — full domain model for ЕПГУ
 * submission. Mirror of `migrationRegistration` table (0035 migration).
 */
export const migrationRegistrationSchema = z.object({
	tenantId: z.string(),
	id: z.string(),
	bookingId: z.string(),
	guestId: z.string(),
	documentId: z.string(),
	epguChannel: epguChannelSchema,
	epguOrderId: z.string().nullable(),
	epguApplicationNumber: z.string().nullable(),
	serviceCode: z.string(),
	targetCode: z.string(),
	supplierGid: z.string(),
	regionCode: z.string(),
	arrivalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	statusCode: z.number().int(),
	isFinal: z.boolean(),
	reasonRefuse: z.string().nullable(),
	errorCategory: epguErrorCategorySchema.nullable(),
	submittedAt: z.string().datetime().nullable(),
	lastPolledAt: z.string().datetime().nullable(),
	nextPollAt: z.string().datetime().nullable(),
	finalizedAt: z.string().datetime().nullable(),
	retryCount: z.number().int().min(0),
	attemptsHistoryJson: z.unknown().nullable(),
	operatorNote: z.string().nullable(),
	createdAt: z.string().datetime(),
	updatedAt: z.string().datetime(),
	createdBy: z.string(),
	updatedBy: z.string(),
})
export type MigrationRegistration = z.infer<typeof migrationRegistrationSchema>

/**
 * Polling cadence per research §3.3 — compute next poll time given
 * current attempt count. Pure function: tested adversarially in repo
 * tests, used both by cron (server) and UI countdown (client).
 *
 * Cadence:
 *   * первые 10 мин (retryCount 0..10): 1 мин
 *   * до 1 часа (retryCount 10..20): 5 мин
 *   * далее (retryCount 20+): экспоненциально (10м, 20м, 40м, 80м, ...)
 *     с cap 24 часа.
 */
export function computeNextPollAtMs(lastPolledAtMs: number, retryCount: number): number {
	const ONE_MIN = 60_000
	if (retryCount < 10) {
		return lastPolledAtMs + ONE_MIN
	}
	if (retryCount < 20) {
		return lastPolledAtMs + 5 * ONE_MIN
	}
	const expSteps = retryCount - 20
	const intervalMin = Math.min(10 * 2 ** expSteps, 24 * 60)
	return lastPolledAtMs + intervalMin * ONE_MIN
}

/**
 * Cross-field invariant: stay period must not exceed 90 days
 * (безвизовый режим) per research §4. Visa-extended stays (180 days)
 * checked separately (visa info in guestDocument). Returns null if
 * within limits, error string for UI display.
 */
export function checkStayPeriodInvariant(
	arrivalDate: string,
	departureDate: string,
	maxDays = 90,
): string | null {
	const arrival = new Date(arrivalDate)
	const departure = new Date(departureDate)
	if (Number.isNaN(arrival.getTime()) || Number.isNaN(departure.getTime())) {
		return 'Некорректный формат даты'
	}
	const ms = departure.getTime() - arrival.getTime()
	const days = ms / (24 * 3600 * 1000)
	if (days < 0) return 'Дата отъезда раньше даты прибытия'
	if (days > maxDays) {
		return `Срок пребывания превышает ${maxDays} дней (текущий: ${Math.ceil(days)} дней)`
	}
	return null
}

/**
 * Patch input — only fields actually wired through to the repo. Status FSM
 * advances by cron / cancel endpoint, NOT by generic patch.
 *
 * Wired fields:
 *   - `retryRequested`: triggers retry via repo.patch (retryCount += 1 +
 *     reset nextPollAt). Manual operator action.
 *   - `operatorNote`: free-form text (max 2000 chars), three-state semantic:
 *     undefined → no change, null → clear, value → set. Audit projection
 *     auto via migrationRegistration_events CHANGEFEED → activity (fieldChange).
 *
 * Future (NOT in this schema yet — must be wired before adding):
 *   - `manuallyCancelled` lives как dedicated POST /:id/cancel endpoint
 *     (M8.A.5.cancel done) — НЕ через generic patch (FSM transition должен
 *     быть explicit).
 */
export const migrationRegistrationPatchSchema = z
	.object({
		retryRequested: z.boolean().optional(),
		operatorNote: z.string().max(2000).nullable().optional(),
	})
	.refine((obj) => Object.keys(obj).length > 0, 'At least one field must be provided')
export type MigrationRegistrationPatch = z.infer<typeof migrationRegistrationPatchSchema>
