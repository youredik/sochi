/**
 * Poll-while-empty refetch interval для list-query, который должен само-исцеляться
 * от транзиентно-пустого результата (read-after-write лаг).
 *
 * Возвращает интервал поллинга (мс) пока список пуст, и `false` (стоп) как только
 * элементы появились ИЛИ список ещё не загружен (undefined — не поллим до первого
 * ответа, начальный fetch делает сам react-query).
 *
 * Используется grid properties-query (use-grid-data): свежеонбординнутый тенант
 * ВСЕГДА имеет property (dashboard-guard уводит property-less на /setup), поэтому
 * пустой список = лаг чтения, не норма → поллим до появления. Round 14.6
 * (wizard→/demo→/grid) даёт гонку первого fetch с commit; без self-heal пустой
 * результат кэшировался staleTime=30s и оставлял оператора в вечном skeleton.
 */
export const EMPTY_LIST_POLL_MS = 2_000

export function emptyListRefetchInterval(data: unknown): number | false {
	return Array.isArray(data) && data.length === 0 ? EMPTY_LIST_POLL_MS : false
}
