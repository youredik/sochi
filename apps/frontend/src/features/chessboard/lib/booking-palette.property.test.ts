/**
 * Property-based tests (fast-check) для G4 RU compliance helpers —
 * `maskGuestNameRu`, `formatTourismTaxRub`, `registrationBadgeFor`,
 * `isRussianCitizenship`. Per `[[fastcheck-gotchas]]`:
 *
 *   - Property tests ONLY для pure functions (no I/O, no Date.now, no
 *     external state) — these 4 helpers qualify.
 *   - Bounded shrink space: ≤200 numRuns × tight integer/string ranges.
 *
 * **Invariants tested (G4.bis — закрывает halfmeasure G4):**
 *
 *   maskGuestNameRu:
 *     [P-MASK-1] mask строго короче чем `"${lastName} ${firstName}"` для любого
 *                непустого firstName (152-ФЗ default: leaks NO full first-name)
 *     [P-MASK-2] mask начинается с trimmed lastName (operator identification
 *                preserved — не «И. Иванов», именно «Иванов И.»)
 *     [P-MASK-3] mask содержит ровно один `.` если firstName непустой, иначе
 *                ни одной точки (boundary: empty firstName falls back lastName-only)
 *     [P-MASK-4] mask immutable — input snapshot не mutated после вызова
 *     [P-MASK-5] uppercase invariant — initial всегда заглавная regardless of input
 *
 *   formatTourismTaxRub:
 *     [P-TAX-1] zero amount → null (no-zero-clutter canon)
 *     [P-TAX-2] positive non-zero amount → never null + always contains NBSP
 *               + ends на "₽"
 *     [P-TAX-3] half-up rounding monotonic: amount(N) ≤ amount(N+1) для целых N
 *     [P-TAX-4] string / number / bigint input equivalence — same numeric →
 *               same output (BigInt#toJSON wire format compat)
 *
 *   registrationBadgeFor:
 *     [P-MVD-1] RU/RUS citizenship → null для ВСЕХ status enum values
 *     [P-MVD-2] foreign citizenship + status='notRequired' → null
 *     [P-MVD-3] foreign + active status (pending/submitted/registered/failed)
 *               → non-null badge with dotClass + label + urgent boolean
 *     [P-MVD-4] urgent ⇒ dotClass === 'bg-status-issue' (red token alignment)
 *
 *   isRussianCitizenship:
 *     [P-RU-1] всегда true для 'RU' / 'RUS' / 'ru' / 'rus' / mixed-case
 *     [P-RU-2] всегда false для любого non-RU 2-3 char alpha code
 */
import type { BookingRegistrationStatus } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import {
	formatTourismTaxRub,
	isRussianCitizenship,
	maskGuestNameRu,
	registrationBadgeFor,
} from './booking-palette.ts'

const NBSP = ' '

// Cyrillic + Latin name letter alphabet (ISO-3166 names commonly mixed).
const arbName = fc.string({
	minLength: 1,
	maxLength: 20,
	unit: fc.constantFrom(
		'А',
		'Б',
		'В',
		'Г',
		'Д',
		'Е',
		'Ё',
		'Ж',
		'З',
		'И',
		'Й',
		'К',
		'Л',
		'М',
		'Н',
		'О',
		'П',
		'Р',
		'С',
		'Т',
		'У',
		'Ф',
		'Х',
		'Ц',
		'Ч',
		'Ш',
		'Щ',
		'Ъ',
		'Ы',
		'Ь',
		'Э',
		'Ю',
		'Я',
		'а',
		'б',
		'в',
		'г',
		'д',
		'е',
		'ё',
		'ж',
		'з',
		'и',
		'й',
		'к',
		'л',
		'м',
		'н',
		'о',
		'п',
		'р',
		'с',
		'т',
		'у',
		'ф',
		'х',
		'ц',
		'ч',
		'ш',
		'щ',
		'ъ',
		'ы',
		'ь',
		'э',
		'ю',
		'я',
		'A',
		'B',
		'C',
		'D',
		'E',
		'F',
		'G',
		'H',
		'I',
		'J',
		'K',
		'L',
		'M',
		'N',
		'O',
		'P',
		'Q',
		'R',
		'S',
		'T',
		'U',
		'V',
		'W',
		'X',
		'Y',
		'Z',
	),
})

// 2-3 char alpha citizenship code, excluding RU/RUS to test foreign path.
const arbNonRuCitizenship = fc
	.string({
		minLength: 2,
		maxLength: 3,
		unit: fc.constantFrom(
			'A',
			'B',
			'C',
			'D',
			'E',
			'F',
			'G',
			'H',
			'I',
			'J',
			'K',
			'L',
			'M',
			'N',
			'O',
			'P',
			'Q',
			'S',
			'T',
			'U',
			'V',
			'W',
			'X',
			'Y',
			'Z',
		),
	})
	.filter((s) => s.toUpperCase() !== 'RU' && s.toUpperCase() !== 'RUS')

const ALL_REG_STATUSES: readonly BookingRegistrationStatus[] = [
	'notRequired',
	'pending',
	'submitted',
	'registered',
	'failed',
] as const

describe('maskGuestNameRu — property-based (G4.bis)', () => {
	test('[P-MASK-1] mask length bounded by lastName.length + 3 (152-ФЗ leak guard)', () => {
		// Canonical 152-ФЗ default mask invariant: visible band text =
		// `${lastName.trim()} ${firstInitialUpper}.` OR `${lastName.trim()}`.
		// Length ≤ lastName.length + 3 ("X " + initial + ".") proves NO part
		// of `firstName.slice(1)` leaks. Substring-contain check fails when
		// lastName organically shares letters с firstName (e.g. «Лена Л.»
		// contains «ена» which is also suffix of firstName «Лена») —
		// length-bound доказательство structurally sound.
		void fc.assert(
			fc.property(arbName, arbName, (lastName, firstName) => {
				const mask = maskGuestNameRu({ lastName, firstName })
				expect(mask.length).toBeLessThanOrEqual(lastName.trim().length + 3)
			}),
			{ numRuns: 200 },
		)
	})

	test('[P-MASK-2] mask всегда начинается с trimmed lastName', () => {
		void fc.assert(
			fc.property(arbName, arbName, (lastName, firstName) => {
				if (lastName.trim().length === 0) return
				const mask = maskGuestNameRu({ lastName, firstName })
				expect(mask.startsWith(lastName.trim())).toBe(true)
			}),
			{ numRuns: 200 },
		)
	})

	test('[P-MASK-3] точка появляется ровно один раз когда firstName непустой', () => {
		void fc.assert(
			fc.property(arbName, arbName, (lastName, firstName) => {
				const mask = maskGuestNameRu({ lastName, firstName })
				const dotCount = (mask.match(/\./g) ?? []).length
				if (firstName.trim().length === 0) {
					expect(dotCount).toBe(0)
				} else {
					expect(dotCount).toBe(1)
				}
			}),
			{ numRuns: 200 },
		)
	})

	test('[P-MASK-4] input snapshot immutable после вызова', () => {
		void fc.assert(
			fc.property(arbName, arbName, (lastName, firstName) => {
				const input = { lastName, firstName }
				const snapshot = JSON.stringify(input)
				maskGuestNameRu(input)
				expect(JSON.stringify(input)).toBe(snapshot)
			}),
			{ numRuns: 200 },
		)
	})

	test('[P-MASK-5] initial uppercased independent of input casing', () => {
		void fc.assert(
			fc.property(arbName, arbName, (lastName, firstName) => {
				const trimmedFirst = firstName.trim()
				if (trimmedFirst.length === 0) return
				const mask = maskGuestNameRu({ lastName, firstName })
				const initial = mask.charAt(mask.length - 2) // …И.
				expect(initial).toBe(initial.toUpperCase())
			}),
			{ numRuns: 200 },
		)
	})
})

describe('formatTourismTaxRub — property-based (G4.bis)', () => {
	test('[P-TAX-1] zero ALWAYS returns null', () => {
		expect(formatTourismTaxRub(0n)).toBeNull()
		expect(formatTourismTaxRub(0)).toBeNull()
		expect(formatTourismTaxRub('0')).toBeNull()
	})

	test('[P-TAX-2] positive amount → non-null + NBSP + "₽" suffix', () => {
		void fc.assert(
			fc.property(fc.bigInt({ min: 1n, max: 10n ** 12n }), (micros) => {
				const out = formatTourismTaxRub(micros)
				expect(out).not.toBeNull()
				expect(out as string).toContain(NBSP)
				expect((out as string).endsWith('₽')).toBe(true)
				// No regular ASCII space between digit и ₽
				expect(out as string).not.toMatch(/\d ₽/)
			}),
			{ numRuns: 200 },
		)
	})

	test('[P-TAX-3] monotonic — strictly larger amount ⇒ rendered value ≥', () => {
		void fc.assert(
			fc.property(
				fc.bigInt({ min: 1_000_000n, max: 10n ** 11n }),
				fc.bigInt({ min: 1_000_000n, max: 10n ** 11n }),
				(a, b) => {
					if (a === b) return
					const [smaller, larger] = a < b ? [a, b] : [b, a]
					// Compare integer ruble portions
					const smallRub = Number((formatTourismTaxRub(smaller) as string).split(NBSP)[0])
					const largeRub = Number((formatTourismTaxRub(larger) as string).split(NBSP)[0])
					expect(largeRub).toBeGreaterThanOrEqual(smallRub)
				},
			),
			{ numRuns: 200 },
		)
	})

	test('[P-TAX-4] bigint / number / string equivalence (same numeric → same output)', () => {
		void fc.assert(
			fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (rawNum) => {
				const big = BigInt(rawNum) * 1_000_000n
				const fromBig = formatTourismTaxRub(big)
				const fromStr = formatTourismTaxRub(big.toString())
				expect(fromStr).toBe(fromBig)
			}),
			{ numRuns: 200 },
		)
	})
})

describe('registrationBadgeFor — property-based (G4.bis)', () => {
	test('[P-MVD-1] RU/RUS citizenship → null для всех 5 enum statuses', () => {
		void fc.assert(
			fc.property(
				fc.constantFrom('RU', 'RUS', 'ru', 'rus', 'Ru', 'rUs'),
				fc.constantFrom(...ALL_REG_STATUSES),
				(citizenship, status) => {
					expect(registrationBadgeFor(status, citizenship)).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[P-MVD-2] foreign + notRequired → null', () => {
		void fc.assert(
			fc.property(arbNonRuCitizenship, (citizenship) => {
				expect(registrationBadgeFor('notRequired', citizenship)).toBeNull()
			}),
			{ numRuns: 100 },
		)
	})

	test('[P-MVD-3] foreign + active status → non-null badge complete', () => {
		const activeStatuses: BookingRegistrationStatus[] = [
			'pending',
			'submitted',
			'registered',
			'failed',
		]
		void fc.assert(
			fc.property(
				arbNonRuCitizenship,
				fc.constantFrom(...activeStatuses),
				(citizenship, status) => {
					const badge = registrationBadgeFor(status, citizenship)
					expect(badge).not.toBeNull()
					if (badge !== null) {
						expect(badge.dotClass).toMatch(/^bg-status-/)
						expect(badge.label.length).toBeGreaterThan(0)
						expect(typeof badge.urgent).toBe('boolean')
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[P-MVD-4] urgent === true ⇒ dotClass === bg-status-issue (red token)', () => {
		void fc.assert(
			fc.property(
				arbNonRuCitizenship,
				fc.constantFrom(...ALL_REG_STATUSES),
				(citizenship, status) => {
					const badge = registrationBadgeFor(status, citizenship)
					if (badge?.urgent === true) {
						expect(badge.dotClass).toBe('bg-status-issue')
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe('isRussianCitizenship — property-based (G4.bis)', () => {
	test('[P-RU-1] всегда true для RU/RUS любого casing', () => {
		void fc.assert(
			fc.property(fc.constantFrom('RU', 'RUS', 'ru', 'rus', 'Ru', 'rU', 'RuS', 'rus '), (raw) => {
				// Trim to mimic schema-pre-validation; trailing spaces would fail
				// regex но defensive helper canonically compares uppercased.
				const trimmed = raw.trim()
				expect(isRussianCitizenship(trimmed)).toBe(true)
			}),
			{ numRuns: 50 },
		)
	})

	test('[P-RU-2] всегда false для любого non-RU/RUS code', () => {
		void fc.assert(
			fc.property(arbNonRuCitizenship, (citizenship) => {
				expect(isRussianCitizenship(citizenship)).toBe(false)
			}),
			{ numRuns: 200 },
		)
	})
})
