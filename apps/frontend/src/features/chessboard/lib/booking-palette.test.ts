import type { BookingChannelCode, BookingRegistrationStatus, BookingStatus } from '@horeca/shared'
import { describe, expect, it } from 'bun:test'
import {
	BOOKING_CELL_STYLES,
	channelIndicator,
	DERIVED_BOOKING_CELL_STYLES,
	formatTourismTaxRub,
	maskGuestNameRu,
	paletteFor,
	registrationBadgeFor,
	styleFor,
} from './booking-palette.ts'

describe('booking-palette (M9.5 Phase B Bnovo-parity tokens)', () => {
	const ALL_STATUSES: readonly BookingStatus[] = [
		'confirmed',
		'in_house',
		'checked_out',
		'cancelled',
		'no_show',
	] as const

	describe('exhaustiveness — every backend status has a style', () => {
		it.each([...ALL_STATUSES])(
			'styleFor(%s) returns style with bg+text+label',
			(status: BookingStatus) => {
				const s = styleFor(status)
				expect(s.bg).toMatch(/^bg-status-/)
				expect(s.text).toMatch(/^text-status-/)
				expect(s.label.length).toBeGreaterThan(0)
			},
		)
	})

	describe('exact-value labels (ru-RU, no accidental drift)', () => {
		it('confirmed → Подтверждена', () => {
			expect(styleFor('confirmed').label).toBe('Подтверждена')
		})
		it('in_house → В проживании', () => {
			expect(styleFor('in_house').label).toBe('В проживании')
		})
		it('checked_out → Выехал', () => {
			expect(styleFor('checked_out').label).toBe('Выехал')
		})
		it('cancelled → Отменена', () => {
			expect(styleFor('cancelled').label).toBe('Отменена')
		})
		it('no_show → Не заехал', () => {
			expect(styleFor('no_show').label).toBe('Не заехал')
		})
	})

	describe('Bnovo-parity token mapping', () => {
		it('confirmed → status-confirmed (green = pre-arrival)', () => {
			expect(styleFor('confirmed').bg).toBe('bg-status-confirmed hover:brightness-95')
			expect(styleFor('confirmed').text).toBe('text-status-confirmed-foreground')
		})
		it('in_house → status-occupied (Sochi-blue = currently in-house)', () => {
			expect(styleFor('in_house').bg).toBe('bg-status-occupied hover:brightness-95')
			expect(styleFor('in_house').text).toBe('text-status-occupied-foreground')
		})
		it('checked_out → status-past (grey)', () => {
			expect(styleFor('checked_out').bg).toBe('bg-status-past hover:brightness-95')
		})
		it('cancelled → status-past + line-through visual', () => {
			expect(styleFor('cancelled').bg).toBe('bg-status-past line-through hover:brightness-95')
		})
		it('no_show → status-issue (red — exception requiring action)', () => {
			expect(styleFor('no_show').bg).toBe('bg-status-issue hover:brightness-95')
			expect(styleFor('no_show').text).toBe('text-status-issue-foreground')
		})
	})

	describe('no hardcoded shadcn neutral palette (theme-aware tokens only)', () => {
		it.each([...ALL_STATUSES])(
			'styleFor(%s) NOT use bg-neutral-/bg-blue-/bg-yellow-',
			(status: BookingStatus) => {
				const bg = styleFor(status).bg
				expect(bg).not.toMatch(/bg-neutral-/)
				expect(bg).not.toMatch(/bg-blue-\d/)
				expect(bg).not.toMatch(/bg-yellow-\d/)
			},
		)
	})

	describe('immutability — frozen-style table', () => {
		it('BOOKING_CELL_STYLES referentially stable across calls', () => {
			expect(styleFor('confirmed')).toBe(BOOKING_CELL_STYLES.confirmed)
			expect(styleFor('confirmed')).toBe(styleFor('confirmed'))
		})
	})
})

/**
 * G2 TravelLine 8-color canon extension (2026-05-15) — `paletteFor`
 * derived states. Per `[[strict-tests]]` exact-value + adversarial +
 * immutable.
 *
 *   Precedence canon (top-down — first match wins):
 *     [P1] terminal (cancelled / checked_out / no_show) → domain palette
 *     [P2] confirmed + checkIn < today → overdue (red)
 *     [P3] confirmed + assignedRoomId null → unassigned (turquoise)
 *     [P4] confirmed + checkIn ≥ today + assigned → confirmed (green)
 *     [P5] in_house → occupied (blue), no derived overlay
 *
 *   Adversarial:
 *     [A1] cancelled с overdue conditions → cancelled wins (terminal)
 *     [A2] checked_out с unassigned → checked_out wins (historical)
 *     [A3] no_show с overdue → no_show wins (terminal urgency = no_show
 *          already past «action required» — operator already decided)
 *     [A4] confirmed + checkIn yesterday + unassigned → overdue wins
 *          (most-urgent canon: check-in before room assignment)
 *
 *   Immutable:
 *     [I1] DERIVED_BOOKING_CELL_STYLES references stable across calls
 *     [I2] same inputs → same output reference (no allocation in hot path)
 */
describe('paletteFor — G2 derived states', () => {
	const TODAY = '2026-05-15'
	const YESTERDAY = '2026-05-14'
	const TOMORROW = '2026-05-16'

	describe('[P1] terminal statuses always win', () => {
		it('cancelled → past + line-through, regardless of checkIn / assignedRoomId', () => {
			expect(
				paletteFor({
					booking: { status: 'cancelled', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.cancelled)
		})
		it('checked_out → past (terminal historical)', () => {
			expect(
				paletteFor({
					booking: { status: 'checked_out', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.checked_out)
		})
		it('no_show → issue (operator already decided urgency)', () => {
			expect(
				paletteFor({
					booking: { status: 'no_show', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.no_show)
		})
	})

	describe('[P2-P4] confirmed precedence: overdue > unassigned > confirmed', () => {
		it('[P2] confirmed + checkIn yesterday → overdue (red, «Просрочена»)', () => {
			const result = paletteFor({
				booking: { status: 'confirmed', checkIn: YESTERDAY, assignedRoomId: 'room_1' },
				todayIso: TODAY,
			})
			expect(result).toBe(DERIVED_BOOKING_CELL_STYLES.overdue)
			expect(result.label).toBe('Просрочена')
			expect(result.bg).toBe('bg-status-issue hover:brightness-95')
		})
		it('[P3] confirmed + future checkIn + unassigned → unassigned (turquoise)', () => {
			const result = paletteFor({
				booking: { status: 'confirmed', checkIn: TOMORROW, assignedRoomId: null },
				todayIso: TODAY,
			})
			expect(result).toBe(DERIVED_BOOKING_CELL_STYLES.unassigned)
			expect(result.label).toBe('Не распределена')
			expect(result.bg).toBe('bg-status-unassigned hover:brightness-95')
		})
		it('[P4] confirmed + future + assigned → confirmed (green, base)', () => {
			expect(
				paletteFor({
					booking: { status: 'confirmed', checkIn: TOMORROW, assignedRoomId: 'room_1' },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.confirmed)
		})
		it('[P4.boundary] confirmed + checkIn === today + assigned → confirmed (today is not «overdue»)', () => {
			expect(
				paletteFor({
					booking: { status: 'confirmed', checkIn: TODAY, assignedRoomId: 'room_1' },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.confirmed)
		})
	})

	describe('[P5] in_house — no derived overlays (guest already checked in)', () => {
		it('in_house + past checkIn → still in_house (occupied blue)', () => {
			expect(
				paletteFor({
					booking: { status: 'in_house', checkIn: YESTERDAY, assignedRoomId: 'room_1' },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.in_house)
		})
		it('in_house + null assignedRoomId (data integrity edge) → still in_house', () => {
			expect(
				paletteFor({
					booking: { status: 'in_house', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(BOOKING_CELL_STYLES.in_house)
		})
	})

	describe('adversarial precedence', () => {
		it('[A4] confirmed + checkIn yesterday + unassigned → overdue wins (most-urgent canon)', () => {
			expect(
				paletteFor({
					booking: { status: 'confirmed', checkIn: YESTERDAY, assignedRoomId: null },
					todayIso: TODAY,
				}),
			).toBe(DERIVED_BOOKING_CELL_STYLES.overdue)
		})
	})

	describe('immutable references (memoization-safe)', () => {
		const args = {
			booking: {
				status: 'confirmed' as BookingStatus,
				checkIn: '2026-05-16',
				assignedRoomId: 'r1',
			},
			todayIso: '2026-05-15',
		}
		it('[I1] DERIVED_BOOKING_CELL_STYLES stable across calls', () => {
			expect(DERIVED_BOOKING_CELL_STYLES.overdue).toBe(DERIVED_BOOKING_CELL_STYLES.overdue)
			expect(DERIVED_BOOKING_CELL_STYLES.unassigned).toBe(DERIVED_BOOKING_CELL_STYLES.unassigned)
		})
		it('[I2] same inputs → same output reference', () => {
			expect(paletteFor(args)).toBe(paletteFor(args))
		})
	})

	describe('no hardcoded palettes в derived styles', () => {
		it('overdue NOT использует bg-neutral-/bg-yellow-/bg-red-NNN', () => {
			expect(DERIVED_BOOKING_CELL_STYLES.overdue.bg).not.toMatch(/bg-(neutral|yellow|red)-\d/)
		})
		it('unassigned NOT использует hardcoded palette', () => {
			expect(DERIVED_BOOKING_CELL_STYLES.unassigned.bg).not.toMatch(/bg-(neutral|yellow|red)-\d/)
		})
	})
})

/**
 * G2.bis (2026-05-15) — `channelIndicator` differentiator dot per TravelLine
 * canon. Strict: exhaustive enum coverage + exact-value labels + null-as-
 * meaningful для direct/walkIn.
 */
describe('channelIndicator — G2.bis channel-color differentiator', () => {
	const ALL_CHANNELS: readonly BookingChannelCode[] = [
		'direct',
		'walkIn',
		'yandexTravel',
		'ostrovok',
		'travelLine',
		'bnovo',
		'bookingCom',
		'expedia',
		'airbnb',
	] as const

	describe('exhaustive enum coverage (every BookingChannelCode handled)', () => {
		it.each([...ALL_CHANNELS])(
			'channelIndicator(%s) returns null или ChannelIndicator',
			(code: BookingChannelCode) => {
				const ind = channelIndicator(code)
				if (ind !== null) {
					expect(ind.dotClass).toMatch(/^bg-channel-/)
					expect(ind.label).toMatch(/^Канал: /)
				}
			},
		)
	})

	describe('direct + walkIn — no indicator (operator-originated, no clutter)', () => {
		it('direct → null', () => {
			expect(channelIndicator('direct')).toBe(null)
		})
		it('walkIn → null', () => {
			expect(channelIndicator('walkIn')).toBe(null)
		})
	})

	describe('yandexTravel — red-orange differentiator (Сочи market leader)', () => {
		it('returns bg-channel-yandex dot + canonical label', () => {
			const ind = channelIndicator('yandexTravel')
			expect(ind).not.toBe(null)
			expect(ind?.dotClass).toBe('bg-channel-yandex')
			expect(ind?.label).toBe('Канал: Yandex.Путешествия')
		})
	})

	describe('generic OTA bucket — yellow dot per TravelLine canon', () => {
		const OTA_CHANNELS: readonly BookingChannelCode[] = [
			'ostrovok',
			'travelLine',
			'bnovo',
			'bookingCom',
			'expedia',
			'airbnb',
		]
		it.each([...OTA_CHANNELS])('channelIndicator(%s) → bg-channel-ota', (code) => {
			const ind = channelIndicator(code)
			expect(ind?.dotClass).toBe('bg-channel-ota')
		})
		it('per-channel label distinguishes OTA source', () => {
			expect(channelIndicator('ostrovok')?.label).toBe('Канал: Ostrovok')
			expect(channelIndicator('travelLine')?.label).toBe('Канал: TravelLine')
			expect(channelIndicator('bnovo')?.label).toBe('Канал: Bnovo')
			expect(channelIndicator('bookingCom')?.label).toBe('Канал: Booking.com')
			expect(channelIndicator('expedia')?.label).toBe('Канал: Expedia')
			expect(channelIndicator('airbnb')?.label).toBe('Канал: Airbnb')
		})
	})

	describe('no hardcoded shadcn palette в channel tokens', () => {
		it.each([...ALL_CHANNELS])(
			'channelIndicator(%s).dotClass NOT использует bg-yellow-NNN/bg-red-NNN',
			(code) => {
				const ind = channelIndicator(code)
				if (ind !== null) {
					expect(ind.dotClass).not.toMatch(/bg-(yellow|red|orange)-\d/)
				}
			},
		)
	})

	// -----------------------------------------------------------------
	// G4 (2026-05-15) — RU compliance overlays. 152-ФЗ default-mask
	// canon, tourism-tax formatter, МВД lifecycle badge.
	// -----------------------------------------------------------------

	describe('G4 — maskGuestNameRu (152-ФЗ default-mask canon)', () => {
		it('exact mask format: «Фамилия И.»', () => {
			expect(maskGuestNameRu({ firstName: 'Иван', lastName: 'Иванов' })).toBe('Иванов И.')
		})
		it('first-name initial uppercased even when input lower-case', () => {
			expect(maskGuestNameRu({ firstName: 'мария', lastName: 'Петрова' })).toBe('Петрова М.')
		})
		it('multi-char first name reduced к single initial (адversarial: full name leak)', () => {
			// Catches the regression where first-name прокидывался полностью.
			expect(maskGuestNameRu({ firstName: 'Александр', lastName: 'Сидоров' })).toBe('Сидоров А.')
			expect(maskGuestNameRu({ firstName: 'Александр', lastName: 'Сидоров' })).not.toContain(
				'лександр',
			)
		})
		it('lastName trimmed (whitespace from operator paste)', () => {
			expect(maskGuestNameRu({ firstName: 'Иван', lastName: '  Иванов  ' })).toBe('Иванов И.')
		})
		it('empty firstName falls back to lastName-only (defensive — domain min(1) но migration legacy)', () => {
			expect(maskGuestNameRu({ firstName: '', lastName: 'Иванов' })).toBe('Иванов')
		})
		it('whitespace-only firstName treated як пустое', () => {
			expect(maskGuestNameRu({ firstName: '   ', lastName: 'Иванов' })).toBe('Иванов')
		})
		it('Latin lastName preserves casing (citizenship=US/GB foreign-guest case)', () => {
			expect(maskGuestNameRu({ firstName: 'John', lastName: 'Smith' })).toBe('Smith J.')
		})
		it('immutability — input snapshot не mutated', () => {
			const input = { firstName: 'Иван', lastName: 'Иванов' }
			const before = JSON.stringify(input)
			maskGuestNameRu(input)
			expect(JSON.stringify(input)).toBe(before)
		})
	})

	describe('G4 — formatTourismTaxRub (Сочи 2% chip)', () => {
		it('zero micros → null (no-zero-clutter canon)', () => {
			expect(formatTourismTaxRub(0n)).toBeNull()
			expect(formatTourismTaxRub('0')).toBeNull()
			expect(formatTourismTaxRub(0)).toBeNull()
		})
		// RU typography canon (ГОСТ 8.417): NBSP (U+00A0) между числом и
		// валютным знаком. Helper enforces; tests use literal   to catch
		// regressions to regular ASCII space.
		const NBSP = ' '
		it('exact-value: 120 ₽ from 120_000_000 micros', () => {
			expect(formatTourismTaxRub(120_000_000n)).toBe(`120${NBSP}₽`)
		})
		it('half-up rounding к ближайший whole rub', () => {
			expect(formatTourismTaxRub(120_400_000n)).toBe(`120${NBSP}₽`)
			expect(formatTourismTaxRub(120_500_000n)).toBe(`121${NBSP}₽`)
			expect(formatTourismTaxRub(120_600_000n)).toBe(`121${NBSP}₽`)
		})
		it('handles string serialization (BigInt#toJSON wire format)', () => {
			expect(formatTourismTaxRub('1234560000')).toBe(`1235${NBSP}₽`)
		})
		it('handles JS number input (operator-side computed values)', () => {
			expect(formatTourismTaxRub(50_000_000)).toBe(`50${NBSP}₽`)
		})
		it('large amount (multi-night high-tier suite) rendered correctly', () => {
			expect(formatTourismTaxRub(12_345_000_000n)).toBe(`12345${NBSP}₽`)
		})
		it('uses NBSP not regular space (ГОСТ 8.417 RU typography canon)', () => {
			const out = formatTourismTaxRub(120_000_000n)
			expect(out).not.toBeNull()
			expect(out).toContain(NBSP)
			expect(out).not.toMatch(/\d /) // no digit-then-ASCII-space
		})
	})

	describe('G4 — registrationBadgeFor (МВД lifecycle for foreign guests)', () => {
		const FOREIGN_STATUSES: readonly BookingRegistrationStatus[] = [
			'notRequired',
			'pending',
			'submitted',
			'registered',
			'failed',
		] as const

		it('RU citizenship → ALWAYS null (no badge for citizens)', () => {
			for (const status of FOREIGN_STATUSES) {
				expect(registrationBadgeFor(status, 'RU')).toBeNull()
				expect(registrationBadgeFor(status, 'RUS')).toBeNull()
				expect(registrationBadgeFor(status, 'ru')).toBeNull() // case-insensitive
			}
		})
		it('foreign + notRequired → null (no actionable state)', () => {
			expect(registrationBadgeFor('notRequired', 'US')).toBeNull()
			expect(registrationBadgeFor('notRequired', 'CN')).toBeNull()
		})
		it('pending → red urgent badge «МУ не подан»', () => {
			const badge = registrationBadgeFor('pending', 'US')
			expect(badge?.dotClass).toBe('bg-status-issue')
			expect(badge?.label).toBe('МУ не подан')
			expect(badge?.urgent).toBe(true)
		})
		it('submitted → green non-urgent «МУ отправлен»', () => {
			const badge = registrationBadgeFor('submitted', 'CN')
			expect(badge?.dotClass).toBe('bg-status-confirmed')
			expect(badge?.label).toBe('МУ отправлен')
			expect(badge?.urgent).toBe(false)
		})
		it('registered → blue non-urgent «МУ принят МВД»', () => {
			const badge = registrationBadgeFor('registered', 'DE')
			expect(badge?.dotClass).toBe('bg-status-occupied')
			expect(badge?.label).toBe('МУ принят МВД')
			expect(badge?.urgent).toBe(false)
		})
		it('failed → red urgent «МУ отклонён — повторите»', () => {
			const badge = registrationBadgeFor('failed', 'TR')
			expect(badge?.dotClass).toBe('bg-status-issue')
			expect(badge?.label).toBe('МУ отклонён — повторите')
			expect(badge?.urgent).toBe(true)
		})
		it('exhaustiveness — every BookingRegistrationStatus handled (no implicit fallback)', () => {
			// Enum-cover: explicit assertion for each value. Compiler tree-shake
			// guards against future enum extension being silently dropped.
			for (const status of FOREIGN_STATUSES) {
				const badge = registrationBadgeFor(status, 'US')
				if (status === 'notRequired') {
					expect(badge).toBeNull()
				} else {
					expect(badge).not.toBeNull()
					expect(badge?.label.length).toBeGreaterThan(0)
					expect(badge?.dotClass).toMatch(/^bg-status-/)
				}
			}
		})
		it('urgent flag aligns с red dot (status-issue) consistently', () => {
			for (const status of FOREIGN_STATUSES) {
				const badge = registrationBadgeFor(status, 'US')
				if (badge?.urgent === true) {
					expect(badge.dotClass).toBe('bg-status-issue')
				}
			}
		})
		it('no hardcoded shadcn palette — only status-* tokens', () => {
			for (const status of FOREIGN_STATUSES) {
				const badge = registrationBadgeFor(status, 'US')
				if (badge !== null) {
					expect(badge.dotClass).not.toMatch(/bg-(yellow|red|orange|blue|green)-\d/)
				}
			}
		})

		// G11 v3.1 (2026-05-18) — boolean overload + adversarial undefined handling.
		// Per `[[adversarial-reading-before-done]]` null-slip canon — surfaced
		// 2026-05-18 user-side crash когда stale persisted row (G11 v2 shape)
		// rehydrated с undefined `isForeignCitizen` field → call site passed
		// undefined → `isRussianCitizenship(undefined).toUpperCase()` crash.
		it('[G11v3-B1] boolean true (isForeignCitizen) + pending → foreign-guest badge', () => {
			const badge = registrationBadgeFor('pending', true)
			expect(badge?.urgent).toBe(true)
			expect(badge?.label).toBe('МУ не подан')
		})
		it('[G11v3-B2] boolean false (RU citizen) → ALWAYS null', () => {
			for (const status of FOREIGN_STATUSES) {
				expect(registrationBadgeFor(status, false)).toBeNull()
			}
		})
		it('[G11v3-A1] undefined (stale persisted shape без isForeignCitizen) → null безопасно', () => {
			// Defensive: cached row от старого G11 v2 build (без `isForeignCitizen`
			// field) rehydrates → consumer passes undefined → must NOT crash в
			// isRussianCitizenship(undefined).toUpperCase(). Per dev-server-
			// staleness canon, IDB buster eventually invalidates stale rows,
			// но в-flight queries during transition must degrade gracefully.
			for (const status of FOREIGN_STATUSES) {
				expect(registrationBadgeFor(status, undefined)).toBeNull()
			}
		})
	})
})
