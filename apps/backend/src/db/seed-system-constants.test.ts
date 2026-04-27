/**
 * Tests for the system_constants seed validator.
 *
 * `validateNonOverlap` is the application-level invariant that protects
 * downstream code from ambiguous range queries. Without it, two SEED entries
 * with overlapping `[yearFrom..yearTo]` ranges for the same (category, key)
 * would silently coexist and the production lookup would non-deterministically
 * pick one — exact polumera anti-pattern (`feedback_no_halfway.md`).
 *
 * NOTE: we don't test the YDB-write path here — that's covered by integration
 * tests using a real local YDB. These tests exercise the pure-function
 * validator in isolation.
 */
import { describe, expect, it } from 'vitest'
import { validateNonOverlap } from './seed-system-constants.ts'

type Entry = Parameters<typeof validateNonOverlap>[0][number]

function entry(opts: Partial<Entry> & { yearFrom: number; yearTo: number; key?: string }): Entry {
	return {
		category: 'tax',
		key: opts.key ?? 'foo',
		data: {},
		source: 'test',
		notes: null,
		effectiveFromDate: null,
		effectiveToDate: null,
		...opts,
	} as Entry
}

describe('validateNonOverlap', () => {
	it('passes on empty input', () => {
		expect(() => validateNonOverlap([])).not.toThrow()
	})

	it('passes on a single entry', () => {
		expect(() => validateNonOverlap([entry({ yearFrom: 2026, yearTo: 9999 })])).not.toThrow()
	})

	it('passes on contiguous non-overlapping ranges (year_to + 1 = next year_from)', () => {
		// 2025: [2025..2025], 2026: [2026..2026], 2027+: [2027..9999]
		expect(() =>
			validateNonOverlap([
				entry({ yearFrom: 2025, yearTo: 2025 }),
				entry({ yearFrom: 2026, yearTo: 2026 }),
				entry({ yearFrom: 2027, yearTo: 9999 }),
			]),
		).not.toThrow()
	})

	it('passes on split-year boundary (yearTo == yearFrom of next entry)', () => {
		// Models the НДС accommodation case: льгота до 30.06.2027 (yearTo=2027),
		// затем общая ставка с 01.07.2027 (yearFrom=2027). The disambiguation
		// happens via effectiveToDate / effectiveFromDate at query time.
		expect(() =>
			validateNonOverlap([
				entry({ yearFrom: 2025, yearTo: 2027 }),
				entry({ yearFrom: 2027, yearTo: 9999 }),
			]),
		).not.toThrow()
	})

	it('throws on hard overlap (yearTo > next yearFrom)', () => {
		expect(() =>
			validateNonOverlap([
				entry({ yearFrom: 2025, yearTo: 2027 }),
				entry({ yearFrom: 2026, yearTo: 9999 }),
			]),
		).toThrowError(/overlap.*tax::foo.*\[2025\.\.2027\] overlaps \[2026\.\.9999\]/)
	})

	it('throws on gap (year between entries is uncovered)', () => {
		expect(() =>
			validateNonOverlap([
				entry({ yearFrom: 2025, yearTo: 2025 }),
				entry({ yearFrom: 2027, yearTo: 9999 }),
			]),
		).toThrowError(/gap.*tax::foo.*year 2026 missing/)
	})

	it('isolates validation per (category, key) — independent keys do not interact', () => {
		// `tax::foo` covers 2025-9999 contiguously.
		// `tax::bar` covers only 2027-9999 (no entry for 2025-2026).
		// This MUST pass — `bar` simply has no constants for 2025-2026.
		expect(() =>
			validateNonOverlap([
				entry({ key: 'foo', yearFrom: 2025, yearTo: 2026 }),
				entry({ key: 'foo', yearFrom: 2027, yearTo: 9999 }),
				entry({ key: 'bar', yearFrom: 2027, yearTo: 9999 }),
			]),
		).not.toThrow()
	})

	it('detects overlap regardless of seed input order', () => {
		// validator must sort by yearFrom before comparing
		expect(() =>
			validateNonOverlap([
				entry({ yearFrom: 2026, yearTo: 9999 }),
				entry({ yearFrom: 2025, yearTo: 2027 }), // overlaps with above
			]),
		).toThrowError(/overlap/)
	})

	it('error message includes the category::key for fast diagnosis', () => {
		let caught: Error | undefined
		try {
			validateNonOverlap([
				entry({ category: 'limit', key: 'usn_threshold', yearFrom: 2025, yearTo: 2030 }),
				entry({ category: 'limit', key: 'usn_threshold', yearFrom: 2027, yearTo: 9999 }),
			])
		} catch (e) {
			caught = e as Error
		}
		expect(caught).toBeDefined()
		expect(caught!.message).toContain('limit::usn_threshold')
	})
})
