/**
 * `microsToKopecks` — конвертирует Int64 micros (× 10⁶ kopecks, decimal
 * string serialization on the wire) в `bigint` kopecks для `<Money>`.
 *
 * Booking domain stores money as Int64 micros, kopecks = micros / 1_000_000.
 * UI рендерит через `<Money>` который ожидает kopecks bigint.
 *
 * Tested in `micros-to-kopecks.test.ts` per memory `feedback_strict_tests.md`.
 *
 * Sub-rouble truncation: `BigInt(999_999) / 1_000_000n === 0n`. Это OK для
 * KPI-визуализации (точность ₽1), но НЕ используем для pseudo-fiscal
 * вычислений — налоговый расчёт делается на backend в micros и round-half-up.
 */
export function microsToKopecks(microsStr: string): bigint {
	return BigInt(microsStr) / 1_000_000n
}
