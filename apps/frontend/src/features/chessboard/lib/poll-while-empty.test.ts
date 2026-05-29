import { describe, expect, it } from 'bun:test'
import {
	EMPTY_LIST_POLL_MS,
	emptyListRefetchInterval,
	MAX_EMPTY_POLLS,
} from './poll-while-empty.ts'

describe('emptyListRefetchInterval — bounded self-heal poll-while-empty', () => {
	it('пустой массив, попыток < лимита → поллит (read-after-write self-heal)', () => {
		expect(emptyListRefetchInterval([], 0)).toBe(EMPTY_LIST_POLL_MS)
		expect(emptyListRefetchInterval([], MAX_EMPTY_POLLS - 1)).toBe(EMPTY_LIST_POLL_MS)
	})

	it('непустой массив → стоп (false), как только property появился', () => {
		expect(emptyListRefetchInterval([{ id: 'prop_1' }], 0)).toBe(false)
		expect(emptyListRefetchInterval([{ id: 'prop_1' }], 99)).toBe(false)
	})

	it('пусто, но исчерпан лимит → СТОП (нет бесконечного поллинга для genuinely-empty)', () => {
		expect(emptyListRefetchInterval([], MAX_EMPTY_POLLS)).toBe(false)
		expect(emptyListRefetchInterval([], MAX_EMPTY_POLLS + 5)).toBe(false)
	})

	it('undefined/null (ещё не загружено) → стоп — не поллим до первого ответа', () => {
		expect(emptyListRefetchInterval(undefined, 0)).toBe(false)
		expect(emptyListRefetchInterval(null, 0)).toBe(false)
	})

	it('не-массив (defensive) → стоп', () => {
		expect(emptyListRefetchInterval('oops', 0)).toBe(false)
		expect(emptyListRefetchInterval({}, 0)).toBe(false)
		expect(emptyListRefetchInterval(0, 0)).toBe(false)
	})

	it('default successfulFetches=0 → поллит при пустом (back-compat)', () => {
		expect(emptyListRefetchInterval([])).toBe(EMPTY_LIST_POLL_MS)
	})
})
