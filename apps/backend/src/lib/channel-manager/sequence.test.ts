import { afterEach, describe, expect, test } from 'bun:test'
import {
	__resetSequenceForTesting,
	nextSequenceNumber,
	sequenceFromTimestamp,
	sequenceKey,
} from './sequence.ts'

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

	// Round 13 per-resource sequence — closes Round 10 P1-A canon/impl gap.
	// Prior global counter advanced когда ANY resource consumed numbers;
	// per-resource Map gives independent streams per (tenantId, propertyId, channelId).

	test('[SEQ-R13-1] per-resource keys produce independent streams', () => {
		const keyA = sequenceKey({ tenantId: 'org_a', propertyId: 'p1', channelId: 'YT' })
		const keyB = sequenceKey({ tenantId: 'org_b', propertyId: 'p2', channelId: 'ETG' })
		// Consume 5 numbers for A.
		const aFirst = nextSequenceNumber(keyA)
		nextSequenceNumber(keyA)
		nextSequenceNumber(keyA)
		nextSequenceNumber(keyA)
		const aLast = nextSequenceNumber(keyA)
		// First number for B should not be advanced by A's 5 consumptions.
		// Same-ms encoding: counter starts at 0 for keyB → less than aLast
		// в counter portion if happens within same microsecond.
		const bFirst = nextSequenceNumber(keyB)
		// B's counter is 0 — A's counter is 4 (5 consumptions, 0-indexed).
		// Both share same epoch_us prefix; bFirst should equal sequenceFromTimestamp
		// at current time с counter=0, не counter=5.
		expect(aLast > aFirst).toBe(true)
		// Within same microsecond, B's first should have counter=0 → bFirst lowBits should be 0
		const bCounter = bFirst & ((1n << 12n) - 1n)
		expect(bCounter).toBe(0n)
	})

	test('[SEQ-R13-2] sequenceKey produces stable canonical string', () => {
		const k1 = sequenceKey({ tenantId: 'org_a', propertyId: 'prop_1', channelId: 'YT' })
		const k2 = sequenceKey({ tenantId: 'org_a', propertyId: 'prop_1', channelId: 'YT' })
		expect(k1).toBe(k2)
		expect(k1).toBe('org_a:prop_1:YT')
	})

	test('[SEQ-R13-3] legacy no-key callers remain monotonic (back-compat)', () => {
		// Legacy callers (no key) route to '__global__' shared stream.
		const a = nextSequenceNumber()
		const b = nextSequenceNumber()
		const c = nextSequenceNumber()
		expect(b > a).toBe(true)
		expect(c > b).toBe(true)
	})

	test('[SEQ-R13-4] cross-resource interleave preserves per-key monotonicity', () => {
		const keyA = sequenceKey({ tenantId: 'org_a', propertyId: 'p1', channelId: 'YT' })
		const keyB = sequenceKey({ tenantId: 'org_b', propertyId: 'p1', channelId: 'YT' })
		const a1 = nextSequenceNumber(keyA)
		const b1 = nextSequenceNumber(keyB)
		const a2 = nextSequenceNumber(keyA)
		const b2 = nextSequenceNumber(keyB)
		// Within each key, strict monotonic.
		expect(a2 > a1).toBe(true)
		expect(b2 > b1).toBe(true)
		// Across keys, no ordering guarantee — but no shared advancement either.
	})
})
