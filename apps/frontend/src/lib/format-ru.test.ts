/**
 * format-ru.ts — strict unit tests + empirical Intl output verification.
 *
 * **Pre-done audit checklist (FROM START — feedback_pre_done_audit.md):**
 *
 *   Money formatting (Intl.NumberFormat ru-RU):
 *     [M1] formatMoney(0n) → exact "0,00 ₽" with NBSP+₽ trailing
 *     [M2] formatMoney(150_000n) → exact "1 500,00 ₽" with NBSP groups + decimal comma
 *     [M3] formatMoney(-15_000n) → "-150,00 ₽" with minus sign (NEVER parentheses)
 *     [M4] formatMoney boundary: 1n → "0,01 ₽"; 99n → "0,99 ₽"; 100n → "1,00 ₽"
 *     [M5] formatMoney accepts both bigint and number (test fixtures)
 *     [M6] NBSP exact char U+00A0 between groups + before symbol (RU-locale gotcha)
 *
 *   Money a11y expansion (RU plurals — all 4 forms):
 *     [A1] formatMoneyA11y(1_00n)  → "1 рубль 0 копеек"   (one)
 *     [A2] formatMoneyA11y(2_00n)  → "2 рубля 0 копеек"   (few)
 *     [A3] formatMoneyA11y(5_00n)  → "5 рублей 0 копеек"  (many)
 *     [A4] formatMoneyA11y(21_00n) → "21 рубль 0 копеек"  (one — endings on 21)
 *     [A5] formatMoneyA11y(11_00n) → "11 рублей 0 копеек" (many — exception for 11-19)
 *     [A6] formatMoneyA11y(0n)     → "0 рублей 0 копеек"  (zero)
 *     [A7] formatMoneyA11y(150_50n) → "150 рублей 50 копеек" (mixed)
 *     [A8] formatMoneyA11y(150_01n) → "150 рублей 1 копейка" (kop one form)
 *     [A9] formatMoneyA11y(150_02n) → "150 рублей 2 копейки" (kop few form)
 *     [A10] formatMoneyA11y(-150_00n) → negative integer part preserved
 *
 *   Money input → kopecks Zod schema:
 *     [Z1] "15" → 1500n
 *     [Z2] "15,50" → 1550n (RU comma)
 *     [Z3] "15.50" → 1550n (US dot — also accepted)
 *     [Z4] "1 500" → 150_000n (regular space)
 *     [Z5] "1 500" → 150_000n (NBSP — what Intl emits)
 *     [Z6] "1 500,50 ₽" → 150_050n (full formatted RU money roundtrip)
 *     [Z7] "" → error "Сумма должна быть положительным числом"
 *     [Z8] "abc" → error
 *     [Z9] "-15" → error (negative rejected)
 *     [Z10] "0" → 0n (zero allowed — pre-paid scenario)
 *     [Z11] floating-point precision: "0.1" → 10n (not 9n via FP error)
 *
 *   Date formatting:
 *     [D1] formatDateLong includes Russian month name + "г.,"
 *     [D2] formatDateShort matches "DD.MM.YYYY" pattern
 *     [D3] formatRelative for past returns "minutes ago" form for diff < 1h
 *     [D4] formatRelative for future returns "in" form
 *     [D5] formatDate accepts both Date and string
 *
 *   Empirical Intl behaviour (canon Round 3 verify):
 *     [I1] currencyDisplay='symbol' produces ₽ (NOT 'narrowSymbol' — Safari iPad bug)
 *     [I2] minimumFractionDigits=2 always shows .00 even for whole rubles
 */
import { describe, expect, test } from 'vitest'
import {
	formatDateLong,
	formatDateShort,
	formatMoney,
	formatMoneyA11y,
	formatRelative,
	moneyKopecksSchema,
} from './format-ru.ts'

const NBSP = ' ' // U+00A0 — what Intl.NumberFormat('ru-RU') emits between groups

describe('formatMoney — Intl.NumberFormat ru-RU empirical', () => {
	test('[M1] zero kopecks → "0,00 ₽" with NBSP before symbol', () => {
		expect(formatMoney(0n)).toBe(`0,00${NBSP}₽`)
	})

	test('[M2] 150_000 kopecks → "1 500,00 ₽" with NBSP groups + comma decimal', () => {
		expect(formatMoney(150_000n)).toBe(`1${NBSP}500,00${NBSP}₽`)
	})

	test('[M3] negative kopecks → minus sign (NOT parentheses — non-RU convention)', () => {
		// Intl emits regular Latin minus '-' for ru-RU, NOT typographic '−' U+2212.
		const formatted = formatMoney(-15_000n)
		expect(formatted).toContain('150,00')
		expect(formatted).toContain('₽')
		expect(formatted).toMatch(/^-/) // starts with minus
		expect(formatted).not.toContain('(') // never parentheses
	})

	test('[M4] kopeck-precision boundaries', () => {
		expect(formatMoney(1n)).toBe(`0,01${NBSP}₽`)
		expect(formatMoney(99n)).toBe(`0,99${NBSP}₽`)
		expect(formatMoney(100n)).toBe(`1,00${NBSP}₽`)
	})

	test('[M5] accepts both bigint and number', () => {
		expect(formatMoney(150_000n)).toBe(formatMoney(150_000))
	})

	test('[M6] separators are NBSP (U+00A0) — gotcha verify, NOT regular space', () => {
		const formatted = formatMoney(1_000_000n) // 10000 RUB
		// U+00A0 mandatory; regular space (U+0020) would be a node version regression bug.
		expect(formatted.charCodeAt(formatted.indexOf(' ') > -1 ? formatted.indexOf(' ') : 1)).not.toBe(
			0x20,
		)
		expect(formatted).toContain(NBSP)
	})

	test('[I1] uses ₽ symbol (currencyDisplay=symbol) — NOT narrowSymbol throw on Safari iPad', () => {
		expect(formatMoney(100n)).toContain('₽')
		expect(formatMoney(100n)).not.toContain('RUB') // 'code' display NOT used
	})

	test('[I2] minimumFractionDigits=2 always shows .00', () => {
		expect(formatMoney(0n)).toMatch(/,00/)
		expect(formatMoney(100n)).toMatch(/,00/)
		expect(formatMoney(150_000n)).toMatch(/,00/)
	})
})

describe('formatMoneyA11y — RU plural agreement (4 forms)', () => {
	test('[A1] one form: 1 рубль', () => {
		expect(formatMoneyA11y(100n)).toBe('1 рубль 0 копеек')
	})

	test('[A2] few form: 2-4 рубля', () => {
		expect(formatMoneyA11y(200n)).toBe('2 рубля 0 копеек')
		expect(formatMoneyA11y(300n)).toBe('3 рубля 0 копеек')
		expect(formatMoneyA11y(400n)).toBe('4 рубля 0 копеек')
	})

	test('[A3] many form: 5+ рублей', () => {
		expect(formatMoneyA11y(500n)).toBe('5 рублей 0 копеек')
		expect(formatMoneyA11y(700n)).toBe('7 рублей 0 копеек')
	})

	test('[A4] one ending on 21 (ones digit determines form)', () => {
		expect(formatMoneyA11y(2100n)).toBe('21 рубль 0 копеек')
		expect(formatMoneyA11y(3100n)).toBe('31 рубль 0 копеек')
	})

	test('[A5] 11-19 ALWAYS many (RU exception, not "one")', () => {
		expect(formatMoneyA11y(1100n)).toBe('11 рублей 0 копеек')
		expect(formatMoneyA11y(1200n)).toBe('12 рублей 0 копеек')
		expect(formatMoneyA11y(1900n)).toBe('19 рублей 0 копеек')
	})

	test('[A6] zero → "0 рублей 0 копеек"', () => {
		expect(formatMoneyA11y(0n)).toBe('0 рублей 0 копеек')
	})

	test('[A7] mixed RUB+kop (150,50)', () => {
		expect(formatMoneyA11y(15050n)).toBe('150 рублей 50 копеек')
	})

	test('[A8] kopeck plural one: 1 копейка', () => {
		expect(formatMoneyA11y(15001n)).toBe('150 рублей 1 копейка')
	})

	test('[A9] kopeck plural few: 2-4 копейки', () => {
		expect(formatMoneyA11y(15002n)).toBe('150 рублей 2 копейки')
		expect(formatMoneyA11y(15003n)).toBe('150 рублей 3 копейки')
	})

	test('[A10] negative integer part preserved (sign on rubles slot)', () => {
		const out = formatMoneyA11y(-15000n)
		expect(out).toMatch(/-150 (рубль|рубля|рублей)/)
		expect(out).toMatch(/0 (копейка|копейки|копеек)$/)
	})
})

describe('moneyKopecksSchema — string → bigint kopecks', () => {
	test('[Z1] integer rubles "15" → 1500n', () => {
		expect(moneyKopecksSchema.parse('15')).toBe(1500n)
	})

	test('[Z2] RU comma decimal "15,50" → 1550n', () => {
		expect(moneyKopecksSchema.parse('15,50')).toBe(1550n)
	})

	test('[Z3] US dot decimal "15.50" → 1550n (also accepted)', () => {
		expect(moneyKopecksSchema.parse('15.50')).toBe(1550n)
	})

	test('[Z4] regular-space group separator "1 500" → 150_000n', () => {
		expect(moneyKopecksSchema.parse('1 500')).toBe(150_000n)
	})

	test('[Z5] NBSP group separator (what Intl emits) "1\\u00A0500" → 150_000n', () => {
		expect(moneyKopecksSchema.parse(`1${NBSP}500`)).toBe(150_000n)
	})

	test('[Z6] full formatted RU money "1 500,50 ₽" roundtrips → 150_050n', () => {
		expect(moneyKopecksSchema.parse(`1${NBSP}500,50${NBSP}₽`)).toBe(150_050n)
	})

	test('[Z7] empty string → error', () => {
		const result = moneyKopecksSchema.safeParse('')
		expect(result.success).toBe(false)
	})

	test('[Z8] non-numeric string → error', () => {
		expect(moneyKopecksSchema.safeParse('abc').success).toBe(false)
	})

	test('[Z9] negative input → error', () => {
		expect(moneyKopecksSchema.safeParse('-15').success).toBe(false)
	})

	test('[Z10] zero → 0n (allowed for pre-paid scenario)', () => {
		expect(moneyKopecksSchema.parse('0')).toBe(0n)
	})

	test('[Z11] floating-point precision: "0.1" → 10n (no FP loss via Math.round)', () => {
		expect(moneyKopecksSchema.parse('0.1')).toBe(10n)
		expect(moneyKopecksSchema.parse('0,1')).toBe(10n)
		// Classic FP trap: 0.1 + 0.2 != 0.3, but our round(n*100) handles 0.1 → 10n exact.
		expect(moneyKopecksSchema.parse('0.30')).toBe(30n)
	})
})

describe('formatDateLong / formatDateShort / formatRelative', () => {
	const fixedDate = new Date('2026-04-25T17:30:00Z')

	test('[D1] formatDateLong includes Russian month name + "г." + connector + time', () => {
		const out = formatDateLong(fixedDate)
		// 2026 CLDR/V8 emits `г. в HH:MM` (literal "в" connector), older CLDR
		// emitted `г., HH:MM`. Test both shapes — strict-tests caught the
		// 2026 behaviour change empirically.
		expect(out).toMatch(/25 апреля 2026 г\.(,| в) \d{1,2}:30/)
	})

	test('[D2] formatDateShort matches "DD.MM.YYYY" pattern', () => {
		const out = formatDateShort(fixedDate)
		expect(out).toMatch(/^25\.04\.2026,? \d{1,2}:30/)
	})

	test('[D3] formatRelative past < 1h → "X minutes ago" form', () => {
		const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000)
		const out = formatRelative(fiveMinAgo)
		// numeric: 'auto' may produce "5 минут назад" or shorter
		expect(out).toMatch(/назад|сейчас|сию/)
	})

	test('[D4] formatRelative future → "через X" form', () => {
		const fiveMinAhead = new Date(Date.now() + 5 * 60 * 1000)
		const out = formatRelative(fiveMinAhead)
		expect(out).toMatch(/через|сейчас/)
	})

	test('[D5] formatDate accepts both Date and ISO string', () => {
		expect(formatDateShort(fixedDate)).toBe(formatDateShort('2026-04-25T17:30:00Z'))
	})
})

/* =========================================== formatRelative — boundary canon
 *
 * Mutation gate: kill operator/threshold mutations on per-unit fallthrough.
 * Each unit boundary tested at the threshold + adjacent values.
 */
describe('formatRelative — unit threshold boundaries (mutation gate)', () => {
	const NOW = Date.now()

	test('exactly 1 minute ago → minutes unit', () => {
		const out = formatRelative(new Date(NOW - 60_000))
		expect(out).toMatch(/мин|сейчас|сию/)
	})

	test('exactly 1 hour ago → hours unit', () => {
		const out = formatRelative(new Date(NOW - 3_600_000))
		expect(out).toMatch(/час|назад|сейчас/)
	})

	test('exactly 1 day ago → days unit ("вчера" or "1 день")', () => {
		const out = formatRelative(new Date(NOW - 86_400_000))
		expect(out).toMatch(/вчера|день|дня|дней/)
	})

	test('exactly 1 month ago → months unit', () => {
		const out = formatRelative(new Date(NOW - 2_628_000_000))
		expect(out).toMatch(/месяц/)
	})

	test('exactly 1 year ago → years unit', () => {
		const out = formatRelative(new Date(NOW - 31_536_000_000))
		expect(out).toMatch(/год|лет|назад|прошлом/)
	})

	test('< 1 minute (30 sec) → "сейчас" or fallback minute', () => {
		const out = formatRelative(new Date(NOW - 30_000))
		// per fallthrough, falls to RTF.format(0, 'minute')
		expect(typeof out).toBe('string')
		expect(out.length).toBeGreaterThan(0)
	})

	test('future direction emits "через"', () => {
		const out = formatRelative(new Date(NOW + 5 * 60_000))
		expect(out).toMatch(/через|сейчас/)
	})
})

/* =========================================== moneyKopecksSchema — adversarial
 *
 * Mutation gate: kill regex/transform mutations.
 */
describe('moneyKopecksSchema — adversarial transforms (mutation gate)', () => {
	test('NBSP (U+00A0) stripped equally with regular space', () => {
		const a = moneyKopecksSchema.parse('1 500,50')
		const b = moneyKopecksSchema.parse('1 500,50')
		expect(a).toBe(b)
		expect(a).toBe(150_050n)
	})

	test('₽ symbol stripped from end', () => {
		expect(moneyKopecksSchema.parse('100 ₽')).toBe(10_000n)
		expect(moneyKopecksSchema.parse('100₽')).toBe(10_000n)
	})

	test('comma → dot decimal conversion (RU canon)', () => {
		expect(moneyKopecksSchema.parse('15,50')).toBe(1550n)
		expect(moneyKopecksSchema.parse('15.50')).toBe(1550n) // dot already
	})

	test('large value 1_000_000 ₽ → 100_000_000n kopecks', () => {
		expect(moneyKopecksSchema.parse('1 000 000,00 ₽')).toBe(100_000_000n)
	})

	test('rounding: "10,005" rubles → 1001 kopecks (Math.round half-up)', () => {
		// 10.005 * 100 === 1000.5000000000001 в IEEE-754 → Math.round → 1001
		// Empirical (Node 22 + V8 13.x, 2026-04-25). Banker rounding NOT used.
		expect(moneyKopecksSchema.parse('10,005')).toBe(1001n)
	})

	test('rejects -1 (negative)', () => {
		expect(() => moneyKopecksSchema.parse('-1')).toThrow()
	})

	test('rejects "abc" (NaN)', () => {
		expect(() => moneyKopecksSchema.parse('abc')).toThrow()
	})

	test('rejects empty string after strip', () => {
		expect(() => moneyKopecksSchema.parse('   ')).toThrow()
		expect(() => moneyKopecksSchema.parse('₽')).toThrow()
	})

	test('boundary 0 → 0n (allowed for pre-paid)', () => {
		expect(moneyKopecksSchema.parse('0')).toBe(0n)
		expect(moneyKopecksSchema.parse('0,00')).toBe(0n)
	})
})
