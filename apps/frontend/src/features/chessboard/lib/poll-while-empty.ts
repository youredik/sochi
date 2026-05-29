/**
 * Poll-while-empty refetch interval для list-query, который должен само-исцеляться
 * от транзиентно-пустого результата (read-after-write лаг).
 *
 * Возвращает интервал поллинга (мс) пока список пуст И не превышен лимит попыток;
 * иначе `false` (стоп). Стоп-условия: (1) элементы появились, (2) список ещё не
 * загружен (undefined — начальный fetch делает сам react-query), (3) исчерпан
 * `MAX_EMPTY_POLLS` (защита от БЕСКОНЕЧНОГО поллинга для тенанта, который реально
 * пуст — напр. удалил единственный property; без cap poll крутился бы вечно —
 * research TanStack 2026 / Agent C catch).
 *
 * Используется grid properties-query (use-grid-data): свежеонбординнутый тенант
 * ВСЕГДА имеет property (dashboard-guard уводит property-less на /setup), поэтому
 * пустой список = лаг чтения. Round 14.6 (wizard→removeQueries→/demo→/grid) даёт
 * cold-fetch в окно read-after-write лага YDB; без self-heal пустой результат
 * кэшировался staleTime=30s и оставлял оператора в вечном skeleton.
 *
 * Канон-альтернативы (research): invalidateQueries уже есть в use-bulk-inventory;
 * полное устранение гонки — setQueryData-seed + НЕ removeQueries, либо backend
 * read-your-writes (YDB strong read). Этот poll — bounded resilience-слой поверх.
 *
 * `MAX_EMPTY_POLLS` × `EMPTY_LIST_POLL_MS` = окно бриджа (~30с) — покрывает
 * cold-boot read-lag + CDC drain, но завершается для genuinely-empty.
 */
export const EMPTY_LIST_POLL_MS = 2_000
export const MAX_EMPTY_POLLS = 15

export function emptyListRefetchInterval(data: unknown, successfulFetches = 0): number | false {
	const isEmpty = Array.isArray(data) && data.length === 0
	return isEmpty && successfulFetches < MAX_EMPTY_POLLS ? EMPTY_LIST_POLL_MS : false
}
