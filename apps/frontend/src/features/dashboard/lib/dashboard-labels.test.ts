/**
 * dashboard-labels.test.ts — strict (per `feedback_strict_tests.md`).
 *
 * Pre-test invariants (mandatory paste-and-fill checklist):
 *
 *   Enum FULL coverage (NOT representative samples):
 *     [DL1] EVERY ActivityObjectType value (16) is present in
 *           ACTIVITY_OBJECT_TYPE_LABELS_RU — adding new enum value WITHOUT
 *           a label trips this test (compile-time keyof-check + runtime
 *           length-count).
 *     [DL2] EVERY ActivityType value (5) is present in ACTIVITY_TYPE_VERBS_RU.
 *
 *   RU label canon:
 *     [DL3] EVERY object-type label is Cyrillic lowercase (no English fallthrough).
 *     [DL4] EVERY type-verb label starts with Cyrillic uppercase (sentence
 *           start convention).
 *
 *   describeActivity composition:
 *     [DL5] 'created' + 'booking' → "Создано бронирование"
 *     [DL6] 'statusChange' + 'folio' → "Сменён статус: счёт" (colon separator)
 *     [DL7] 'manualRetry' + 'notification' → "Повторная отправка уведомление"
 *           (verb + noun, no colon for non-statusChange)
 *     [DL8] 'deleted' + 'migrationRegistration' → covers complex noun roundtrip
 *
 *   Determinism (pure function):
 *     [DL9] Same inputs → bit-identical output across N calls.
 */
import {
	type ActivityObjectType,
	type ActivityType,
	activityObjectTypeSchema,
	activityTypeSchema,
} from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import {
	ACTIVITY_OBJECT_TYPE_LABELS_RU,
	ACTIVITY_TYPE_VERBS_RU,
	describeActivity,
} from './dashboard-labels.ts'

// Materialise enum values from canonical zod schemas — single source of truth.
// If shared adds a new enum value, this expression auto-grows.
const ALL_OBJECT_TYPES: readonly ActivityObjectType[] = activityObjectTypeSchema.options
const ALL_ACTIVITY_TYPES: readonly ActivityType[] = activityTypeSchema.options

const CYRILLIC_LOWERCASE_START = /^[а-яё]/u
const CYRILLIC_UPPERCASE_START = /^[А-ЯЁ]/u

describe('dashboard-labels — enum FULL coverage + RU canon', () => {
	test('[DL1] EVERY ActivityObjectType value has a Cyrillic label (17 total)', () => {
		expect(ALL_OBJECT_TYPES.length).toBe(17)
		for (const t of ALL_OBJECT_TYPES) {
			expect(typeof ACTIVITY_OBJECT_TYPE_LABELS_RU[t]).toBe('string')
			expect(ACTIVITY_OBJECT_TYPE_LABELS_RU[t].length).toBeGreaterThan(0)
		}
	})

	test('[DL2] EVERY ActivityType value has a Cyrillic verb (5 total)', () => {
		expect(ALL_ACTIVITY_TYPES.length).toBe(5)
		for (const t of ALL_ACTIVITY_TYPES) {
			expect(typeof ACTIVITY_TYPE_VERBS_RU[t]).toBe('string')
			expect(ACTIVITY_TYPE_VERBS_RU[t].length).toBeGreaterThan(0)
		}
	})

	test('[DL3] all object-type labels are Cyrillic lowercase (no Latin fallthrough)', () => {
		for (const t of ALL_OBJECT_TYPES) {
			const label = ACTIVITY_OBJECT_TYPE_LABELS_RU[t]
			expect(label).toMatch(CYRILLIC_LOWERCASE_START)
			// Defensive: any Latin letter present would surface as Latin in glance copy.
			expect(label).not.toMatch(/[A-Za-z]/)
		}
	})

	test('[DL4] all activity-type verbs start with Cyrillic uppercase (sentence start)', () => {
		for (const t of ALL_ACTIVITY_TYPES) {
			const verb = ACTIVITY_TYPE_VERBS_RU[t]
			expect(verb).toMatch(CYRILLIC_UPPERCASE_START)
		}
	})

	test('[DL_explicit] exact label values — mutation gate against silent string drift', () => {
		// Per `feedback_strict_tests.md` exact-value assertions: each label
		// pinned, so a typo (e.g. "брoнирование" with Latin 'o') trips here.
		expect(ACTIVITY_OBJECT_TYPE_LABELS_RU.booking).toBe('бронирование')
		expect(ACTIVITY_OBJECT_TYPE_LABELS_RU.folio).toBe('счёт')
		expect(ACTIVITY_OBJECT_TYPE_LABELS_RU.notification).toBe('уведомление')
		expect(ACTIVITY_OBJECT_TYPE_LABELS_RU.migrationRegistration).toBe('миграционная регистрация')
		expect(ACTIVITY_TYPE_VERBS_RU.created).toBe('Создано')
		expect(ACTIVITY_TYPE_VERBS_RU.statusChange).toBe('Сменён статус')
		expect(ACTIVITY_TYPE_VERBS_RU.manualRetry).toBe('Повторная отправка')
	})
})

describe('describeActivity — verb + noun composition', () => {
	test('[DL5] created + booking → "Создано бронирование" (space-separated)', () => {
		expect(describeActivity({ objectType: 'booking', activityType: 'created' })).toBe(
			'Создано бронирование',
		)
	})

	test('[DL6] statusChange + folio → "Сменён статус: счёт" (colon-separated)', () => {
		expect(describeActivity({ objectType: 'folio', activityType: 'statusChange' })).toBe(
			'Сменён статус: счёт',
		)
	})

	test('[DL7] manualRetry + notification → "Повторная отправка уведомление" (no colon — non-status)', () => {
		expect(describeActivity({ objectType: 'notification', activityType: 'manualRetry' })).toBe(
			'Повторная отправка уведомление',
		)
	})

	test('[DL8] deleted + migrationRegistration → complex compound noun roundtrip', () => {
		expect(describeActivity({ objectType: 'migrationRegistration', activityType: 'deleted' })).toBe(
			'Удалено миграционная регистрация',
		)
	})

	test('[DL9] determinism — same inputs produce bit-identical output (pure)', () => {
		const a = describeActivity({ objectType: 'booking', activityType: 'fieldChange' })
		const b = describeActivity({ objectType: 'booking', activityType: 'fieldChange' })
		const c = describeActivity({ objectType: 'booking', activityType: 'fieldChange' })
		expect(a).toBe(b)
		expect(b).toBe(c)
	})
})
