/**
 * Dashboard activity-feed label maps — single source of truth для RU strings,
 * keyed by canonical `ActivityObjectType` + `ActivityType` enums из
 * `@horeca/shared`.
 *
 * Lives in `features/dashboard/lib/` (NOT shared) — labels are operator-facing
 * dashboard glance copy; backend / channel adapters / API responses do NOT
 * consume them. Per `feedback_form_pattern_rule.md` Vite Fast Refresh canon:
 * non-component constant module — keeps importing `recent-activity-list.tsx`
 * a component-only module.
 *
 * Coverage discipline (per `feedback_strict_tests.md` "Enum FULL coverage"):
 * EVERY value of `ActivityObjectType` (17 values) and `ActivityType` (5 values)
 * MUST map to a Cyrillic label here — adding a new enum value WITHOUT a label
 * trips the strict test `dashboard-labels.test.ts` that mirrors both enums.
 *
 * Caller pattern (`recent-activity-list.tsx`):
 *   ACTIVITY_OBJECT_TYPE_LABELS_RU[row.objectType]  // → "бронирование"
 *   ACTIVITY_TYPE_VERBS_RU[row.activityType]         // → "создано"
 *   → "Создано бронирование"  (verb + noun composition)
 */
import type { ActivityObjectType, ActivityType } from '@horeca/shared'

/**
 * Cyrillic noun for the audited entity — singular nominative, lowercase
 * (composes after a verb at sentence start: «Создано <X>»).
 */
export const ACTIVITY_OBJECT_TYPE_LABELS_RU: Readonly<Record<ActivityObjectType, string>> =
	Object.freeze({
		booking: 'бронирование',
		property: 'объект размещения',
		roomType: 'тип номера',
		room: 'номер',
		ratePlan: 'тариф',
		availability: 'доступность',
		rate: 'цена',
		guest: 'гость',
		folio: 'счёт',
		payment: 'платёж',
		refund: 'возврат',
		receipt: 'чек',
		dispute: 'спор',
		notification: 'уведомление',
		migrationRegistration: 'миграционная регистрация',
		channelDispatch: 'отправка в канал',
		channelInbox: 'входящее из канала',
	})

/**
 * Cyrillic verb for the change kind — past-tense neuter (composes with any
 * objectType label since Russian past-tense neuter agrees with all genders
 * when used impersonally: «Создано бронирование», «Создано уведомление»).
 *
 * Choices reflect operator-facing semantics:
 *   - 'created' → «Создано» (object exists now)
 *   - 'fieldChange' → «Изменено» (one field modified — most common audit row)
 *   - 'statusChange' → «Сменён статус» (state-machine transition, glance-relevant)
 *   - 'deleted' → «Удалено» (rare; audit retention 2 года)
 *   - 'manualRetry' → «Повторная отправка» (operator-triggered notification retry)
 */
export const ACTIVITY_TYPE_VERBS_RU: Readonly<Record<ActivityType, string>> = Object.freeze({
	created: 'Создано',
	fieldChange: 'Изменено',
	statusChange: 'Сменён статус',
	deleted: 'Удалено',
	manualRetry: 'Повторная отправка',
})

/**
 * Compose canonical glance phrase for the dashboard feed row.
 * Pure: deterministic for testability.
 */
export function describeActivity(args: {
	objectType: ActivityObjectType
	activityType: ActivityType
}): string {
	const verb = ACTIVITY_TYPE_VERBS_RU[args.activityType]
	const noun = ACTIVITY_OBJECT_TYPE_LABELS_RU[args.objectType]
	// "Создано бронирование", "Сменён статус: счёт"
	if (args.activityType === 'statusChange') return `${verb}: ${noun}`
	return `${verb} ${noun}`
}
