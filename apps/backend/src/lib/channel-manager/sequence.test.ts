import { afterEach, describe, expect, test } from 'bun:test'
import { __resetSequenceForTesting, nextSequenceNumber, sequenceFromTimestamp } from './sequence.ts'

describe('sequence (Round 8 canon — per-resource monotonic ordering)', () => {
	afterEach(() => __resetSequenceForTesting())

	test('nextSequenceNumber returns strictly-increasing values', () => {
		const seqs: bigint[] = []
		for (let i = 0; i < 100; i++) seqs.push(nextSequenceNumber())
		for (let i = 1; i < seqs.length; i++) {
			const current = seqs[i]
			const previous = seqs[i - 1]
			if (current === undefined || previous === undefined) throw new Error('unreachable')
			expect(current > previous).toBe(true)
		}
	})

	test('rapid burst within single millisecond still strictly increases via counter', () => {
		// All 4096 sub-ms slots within same ms must be strictly increasing.
		const burst: bigint[] = []
		for (let i = 0; i < 4096; i++) burst.push(nextSequenceNumber())
		for (let i = 1; i < burst.length; i++) {
			const current = burst[i]
			const previous = burst[i - 1]
			if (current === undefined || previous === undefined) throw new Error('unreachable')
			expect(current > previous).toBe(true)
		}
	})

	test('sequenceFromTimestamp matches expected encoding', () => {
		const ts = 1735689600000 // 2025-01-01T00:00:00Z in ms
		const seq = sequenceFromTimestamp(ts, 0)
		const decodedMicros = seq >> 12n
		expect(decodedMicros).toBe(BigInt(ts) * 1000n)
	})

	test('sequenceFromTimestamp with counter encodes both', () => {
		const ts = 1735689600000
		const seq0 = sequenceFromTimestamp(ts, 0)
		const seq1 = sequenceFromTimestamp(ts, 1)
		expect(seq1 - seq0).toBe(1n)
	})

	test('out-of-order detection: later seq > earlier seq', () => {
		const earlier = nextSequenceNumber()
		const later = nextSequenceNumber()
		// Consumer logic: if observed seq < lastSeq seen, drop as stale.
		const stale = later < earlier
		expect(stale).toBe(false)
		expect(earlier < later).toBe(true)
	})
})
