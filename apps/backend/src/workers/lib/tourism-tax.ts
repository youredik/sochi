/**
 * Pure functions for the Russian tourism tax (туристический налог) computation.
 *
 * Per НК РФ глава 33.1 (введена 2025) + Сочи Решение № 100 от 31.10.2024:
 *   - **База** = стоимость услуг по предоставлению мест для временного
 *     проживания, БЕЗ НДС (которое 0% для accommodation per Постановление-1860,
 *     продлено до 31.12.2030) и БЕЗ самого turNalog.
 *   - **Ставка** хранится per-property в `tourismTaxRateBps` (basis-points).
 *     Сочи 2026 = 200 (= 2%). Динамика: 1%(2025) → 2%(2026) → 3%(2027) → 4% → 5%.
 *     Сириус — отдельная федеральная территория, тоже 2%, но ОТДЕЛЬНЫЙ NPA.
 *   - **Минимум** = 100 ₽ × количество суток × количество номеров (НЕ гостей!) —
 *     per-stay floor (НК РФ ст. 418.5 п.1). Bnovo/TravelLine canon: считают
 *     `tax = max(round(base × rate), 100 × nights × rooms)` на уровне всего
 *     booking, не на ночь.
 *   - **Округление**: до полного рубля по правилам НК РФ ст. 52 п. 6 — half-up.
 *
 * **Anti-patterns** (research synthesis 2026-04-26):
 *   - Float-арифметика для 2% — overflow / IEEE-754 surprises. Use bigint
 *     `(baseMinor * BigInt(rateBp)) / 10_000n`.
 *   - Min computed per-guest вместо per-room — двойной счёт, overpayment.
 *   - Per-night posting вместо at-checkout — приводит к сторно-стормам при
 *     mid-stay edits (продление/cancel ночи). Apaleo/Bnovo: один post на checkout.
 *
 * Льготы (WW2 vets, инвалиды I-II, участники СВО+семьи, военные в командировке):
 *   V1 НЕ поддерживаем — добавим вместе с М8 МВД flow (общий guest-document
 *   storage). Сейчас закладываем сигнатуру `exemptNights` как параметр чтобы не
 *   ломать API когда докатим.
 */

const RATE_BASIS_DENOMINATOR = 10_000n // 200 bps × base / 10_000 = 2% × base
const MIN_TAX_PER_NIGHT_PER_ROOM_MINOR = 10_000n // 100 ₽ × 100 коп = 10_000 минор
const KOPECKS_PER_RUBLE = 100n

/**
 * Compute tourism tax on the given accommodation base.
 *
 * @param baseMinor       sum of accommodation gross over all nights, in minor
 *                        units (kopecks). Pass 0n if booking has 0 base — will
 *                        return 0n (no tax on zero revenue).
 * @param rateBp          tax rate in basis points. Сочи 2026 = 200 (2%).
 *                        Pass 0 to skip tax entirely (e.g. property in non-
 *                        adopted region; defensive against missing config).
 * @param nights          number of stay nights. Used for minimum floor.
 * @param rooms           number of rooms in the booking (default 1 — single-room
 *                        bookings, our V1 inventory). Multi-room reservations
 *                        multiply the floor.
 * @param exemptNights    nights exempt from minimum floor (льготники).
 *                        V1 always pass 0 — schema lands with М8 МВД flow.
 *
 * Returns kopecks (minor) as bigint, rounded to the full ruble per НК РФ ст. 52 п. 6.
 *
 * Examples:
 *   computeTourismTax(500_000n, 200, 1, 1)         → 10_000n  (2% × 5000₽ = 100₽)
 *   computeTourismTax(2_500_000n, 200, 5, 1)       → 50_000n  (2% × 25000₽ = 500₽)
 *   computeTourismTax(100_000n, 200, 3, 1)         → 30_000n  (min: 3 × 100₽ = 300₽)
 *   computeTourismTax(0n, 200, 5, 1)               → 0n       (no base = no tax)
 *   computeTourismTax(1_000_000n, 0, 5, 1)         → 0n       (rate 0 = exempt)
 *   computeTourismTax(1_000_000n, 200, 1, 2)       → 20_000n  (computed 200₽ ≥ floor 200₽)
 */
export function computeTourismTax(
	baseMinor: bigint,
	rateBp: number,
	nights: number,
	rooms: number = 1,
	exemptNights: number = 0,
): bigint {
	if (baseMinor < 0n) {
		throw new RangeError(`computeTourismTax: baseMinor must be >= 0, got ${baseMinor}`)
	}
	if (!Number.isInteger(rateBp) || rateBp < 0) {
		throw new RangeError(`computeTourismTax: rateBp must be non-negative integer, got ${rateBp}`)
	}
	if (!Number.isInteger(nights) || nights < 0) {
		throw new RangeError(`computeTourismTax: nights must be non-negative integer, got ${nights}`)
	}
	if (!Number.isInteger(rooms) || rooms < 1) {
		throw new RangeError(`computeTourismTax: rooms must be positive integer, got ${rooms}`)
	}
	if (!Number.isInteger(exemptNights) || exemptNights < 0 || exemptNights > nights) {
		throw new RangeError(
			`computeTourismTax: exemptNights must be in [0, ${nights}], got ${exemptNights}`,
		)
	}

	if (baseMinor === 0n || rateBp === 0 || nights === 0) return 0n

	// Computed tax: base × rateBp / 10_000, rounded HALF-UP to the full ruble.
	// `roundHalfUpToRuble` only ever shifts up, never down, so the result can
	// be at most 50 копеек higher than the float equivalent — within НК РФ ст. 52 п.6.
	const rawMinor = (baseMinor * BigInt(rateBp)) / RATE_BASIS_DENOMINATOR
	const computed = roundHalfUpToRuble(rawMinor)

	// Minimum floor: 100₽ × nights × rooms (excluding exempt nights).
	const billableNights = BigInt(nights - exemptNights)
	const floor = MIN_TAX_PER_NIGHT_PER_ROOM_MINOR * billableNights * BigInt(rooms)

	return computed > floor ? computed : floor
}

/**
 * Round bigint kopecks to the next full ruble using HALF-UP semantics
 * (≥0.5 rounds up, < 0.5 rounds down). Per НК РФ ст. 52 п. 6.
 *
 * Negative values not expected here (tax base always ≥ 0), but defensive math
 * still works: -49 → 0 (rounds toward zero with half-up sign convention is
 * equivalent to "round away from zero on .5", but we never see negatives).
 */
function roundHalfUpToRuble(minor: bigint): bigint {
	const remainder = minor % KOPECKS_PER_RUBLE
	if (remainder === 0n) return minor
	if (remainder >= 50n) return minor + (KOPECKS_PER_RUBLE - remainder)
	return minor - remainder
}

/**
 * Deterministic folioLine ID for a booking's tourism-tax post. PK collision =
 * idempotency, so re-running checkout-finalizer (CDC retry, manual replay)
 * is a no-op. One tax line per booking by canon.
 */
export function tourismTaxLineId(bookingId: string): string {
	return `tax_${bookingId}`
}
