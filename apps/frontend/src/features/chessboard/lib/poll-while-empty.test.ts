import { describe, expect, it } from 'bun:test'
import { EMPTY_LIST_POLL_MS, emptyListRefetchInterval } from './poll-while-empty.ts'

describe('emptyListRefetchInterval — self-heal poll-while-empty', () => {
	it('пустой массив → поллит (read-after-write self-heal)', () => {
		expect(emptyListRefetchInterval([])).toBe(EMPTY_LIST_POLL_MS)
	})

	it('непустой массив → стоп (false), как только property появился', () => {
		expect(emptyListRefetchInterval([{ id: 'prop_1' }])).toBe(false)
	})

	it('undefined/null (ещё не загружено) → стоп — не поллим до первого ответа', () => {
		expect(emptyListRefetchInterval(undefined)).toBe(false)
		expect(emptyListRefetchInterval(null)).toBe(false)
	})

	it('не-массив (defensive) → стоп', () => {
		expect(emptyListRefetchInterval('oops')).toBe(false)
		expect(emptyListRefetchInterval({})).toBe(false)
		expect(emptyListRefetchInterval(0)).toBe(false)
	})
})
