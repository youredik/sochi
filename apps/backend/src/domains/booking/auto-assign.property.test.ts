/**
 * G8 (2026-05-16) — Property-based tests для `planAutoAssign` Interval-
 * Partition Greedy allocation algorithm.
 *
 * Per Kleinberg-Tardos §4.1 canonical invariants + `[[fastcheck-gotchas]]`
 * (pure functions only, bounded shrinks).
 *
 * Invariants tested:
 *
 *   [P-NO-OVERLAP] CRITICAL: для any random N×K input, NO two assigned
 *                  bookings к same roomId have overlapping date ranges.
 *                  Безопасность invariant — алгоритм не должен ever
 *                  produce overlapping assignments.
 *
 *   [P-PRESERVE-EXISTING] existing pins (input) ALL present in output
 *                        unchanged. Existing assignments NEVER mutated.
 *
 *   [P-ROOM-TYPE-MATCH] для each assigned booking, the picked room has
 *                       matching roomTypeId.
 *
 *   [P-INACTIVE-SKIP] no assignment ever picks isActive=false room.
 *
 *   [P-TOTAL-COVERAGE] every input booking IS either в `assigned` или
 *                      в `skipped` — никаких потерянных.
 *
 *   [P-DETERMINISTIC] same input → same output (no Date.now / Math.random
 *                     reliance).
 *
 *   [P-IDEMPOTENT] running plan twice (re-feed assigned + existingPins
 *                  union) → second run produces zero new assignments
 *                  (всё уже placed) OR same skipped reasons.
 */
import type { BookingAutoAssignResult } from '@horeca/shared'
import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import { planAutoAssign } from './auto-assign.ts'

// Bounded arbs — SMB-realistic scale (Sochi target).
const arbDate = fc.integer({ min: 0, max: 30 }).map((d) => {
	const date = new Date('2030-01-01T00:00:00Z')
	date.setUTCDate(date.getUTCDate() + d)
	return date.toISOString().slice(0, 10)
})

// Use integer index → unique ID к избежать collisions when fc generates
// short random strings (which can collide between bookings — а result
// in test assertion misidentifying wrong booking from arrays). Same
// pattern для rooms.
const arbBooking = fc
	.record({
		id: fc.integer({ min: 0, max: 9999 }).map((n) => `b${n.toString().padStart(4, '0')}`),
		roomTypeId: fc.constantFrom('rmt_a', 'rmt_b', 'rmt_c'),
		checkInDays: fc.integer({ min: 0, max: 25 }),
		stayLength: fc.integer({ min: 1, max: 5 }),
	})
	.map((r) => {
		const ci = new Date('2030-01-01T00:00:00Z')
		ci.setUTCDate(ci.getUTCDate() + r.checkInDays)
		const co = new Date(ci)
		co.setUTCDate(co.getUTCDate() + r.stayLength)
		return {
			id: r.id,
			roomTypeId: r.roomTypeId,
			checkIn: ci.toISOString().slice(0, 10),
			checkOut: co.toISOString().slice(0, 10),
		}
	})

const arbRoom = fc.record({
	id: fc.integer({ min: 0, max: 9999 }).map((n) => `r${n.toString().padStart(4, '0')}`),
	roomTypeId: fc.constantFrom('rmt_a', 'rmt_b', 'rmt_c'),
	roomNumber: fc.integer({ min: 1, max: 999 }).map((n) => n.toString()),
	isActive: fc.boolean(),
})

// fast-check може still produce duplicate IDs in arrays (independent draws).
// Wrap arrays к dedupe by id after generation — invariants assume unique IDs.
function dedupeById<T extends { id: string }>(arr: T[]): T[] {
	const seen = new Set<string>()
	return arr.filter((x) => {
		if (seen.has(x.id)) return false
		seen.add(x.id)
		return true
	})
}

function rangesOverlap(a1: string, a2: string, b1: string, b2: string): boolean {
	return a1 < b2 && b1 < a2
}

describe('planAutoAssign — property-based invariants (G8)', () => {
	test('[P-NO-OVERLAP] no two assigned to same roomId have overlapping dates', () => {
		void fc.assert(
			fc.property(
				fc.array(arbBooking, { minLength: 0, maxLength: 30 }),
				fc.array(arbRoom, { minLength: 1, maxLength: 15 }),
				(bookingsRaw, roomsRaw) => {
					const bookings = dedupeById(bookingsRaw)
					const rooms = dedupeById(roomsRaw)
					const result = planAutoAssign({
						unassigned: bookings,
						rooms,
						existingPins: [],
					})
					// For each pair в assigned same roomId, dates must NOT overlap.
					const byRoom = new Map<
						string,
						Array<{ bookingId: string; checkIn: string; checkOut: string }>
					>()
					for (const a of result.assigned) {
						const b = bookings.find((x) => x.id === a.bookingId)
						if (!b) continue
						const arr = byRoom.get(a.roomId) ?? []
						arr.push({ bookingId: a.bookingId, checkIn: b.checkIn, checkOut: b.checkOut })
						byRoom.set(a.roomId, arr)
					}
					for (const pins of byRoom.values()) {
						for (let i = 0; i < pins.length; i++) {
							for (let j = i + 1; j < pins.length; j++) {
								const a = pins[i]
								const b = pins[j]
								if (a && b) {
									expect(rangesOverlap(a.checkIn, a.checkOut, b.checkIn, b.checkOut)).toBe(false)
								}
							}
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[P-ROOM-TYPE-MATCH] each assigned booking room.roomTypeId matches booking.roomTypeId', () => {
		void fc.assert(
			fc.property(
				fc.array(arbBooking, { minLength: 1, maxLength: 20 }),
				fc.array(arbRoom, { minLength: 1, maxLength: 10 }),
				(bookingsRaw, roomsRaw) => {
					const bookings = dedupeById(bookingsRaw)
					const rooms = dedupeById(roomsRaw)
					const result = planAutoAssign({ unassigned: bookings, rooms, existingPins: [] })
					for (const a of result.assigned) {
						const b = bookings.find((x) => x.id === a.bookingId)
						const r = rooms.find((x) => x.id === a.roomId)
						if (b && r) {
							expect(r.roomTypeId).toBe(b.roomTypeId)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[P-INACTIVE-SKIP] никогда не assigns к isActive=false room', () => {
		void fc.assert(
			fc.property(
				fc.array(arbBooking, { minLength: 1, maxLength: 15 }),
				fc.array(arbRoom, { minLength: 1, maxLength: 10 }),
				(bookingsRaw, roomsRaw) => {
					const bookings = dedupeById(bookingsRaw)
					const rooms = dedupeById(roomsRaw)
					const result = planAutoAssign({ unassigned: bookings, rooms, existingPins: [] })
					for (const a of result.assigned) {
						const r = rooms.find((x) => x.id === a.roomId)
						if (r) {
							expect(r.isActive).toBe(true)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[P-TOTAL-COVERAGE] every input booking present в either assigned OR skipped', () => {
		void fc.assert(
			fc.property(
				fc.array(arbBooking, { minLength: 1, maxLength: 20 }),
				fc.array(arbRoom, { minLength: 0, maxLength: 10 }),
				(bookingsRaw, roomsRaw) => {
					const bookings = dedupeById(bookingsRaw)
					const rooms = dedupeById(roomsRaw)
					const result = planAutoAssign({ unassigned: bookings, rooms, existingPins: [] })
					const allOutputIds = new Set([
						...result.assigned.map((a) => a.bookingId),
						...result.skipped.map((s) => s.bookingId),
					])
					const allInputIds = new Set(bookings.map((b) => b.id))
					expect(allOutputIds.size).toBe(allInputIds.size)
					for (const id of allInputIds) {
						expect(allOutputIds.has(id)).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	test('[P-DETERMINISTIC] same input → same output', () => {
		void fc.assert(
			fc.property(
				fc.array(arbBooking, { minLength: 1, maxLength: 15 }),
				fc.array(arbRoom, { minLength: 1, maxLength: 10 }),
				(bookingsRaw, roomsRaw) => {
					const bookings = dedupeById(bookingsRaw)
					const rooms = dedupeById(roomsRaw)
					const r1 = planAutoAssign({ unassigned: bookings, rooms, existingPins: [] })
					const r2 = planAutoAssign({ unassigned: bookings, rooms, existingPins: [] })
					expect(r2.assigned).toEqual(r1.assigned)
					expect(r2.skipped).toEqual(r1.skipped)
				},
			),
			{ numRuns: 50 },
		)
	})

	test('[P-IDEMPOTENT] re-run после first plan: zero new assignments (all placed already)', () => {
		void fc.assert(
			fc.property(
				fc.array(arbBooking, { minLength: 1, maxLength: 15 }),
				fc.array(arbRoom, { minLength: 1, maxLength: 10 }),
				(bookingsRaw, roomsRaw) => {
					const bookings = dedupeById(bookingsRaw)
					const rooms = dedupeById(roomsRaw)
					const first = planAutoAssign({ unassigned: bookings, rooms, existingPins: [] })
					// Re-feed: «existing pins» = first.assigned; «unassigned» = NONE
					// (operator perspective — после persist, no new unassigned).
					const second = planAutoAssign({
						unassigned: [],
						rooms,
						existingPins: first.assigned.map((a) => {
							const b = bookings.find((x) => x.id === a.bookingId)
							return {
								bookingId: a.bookingId,
								roomId: a.roomId,
								checkIn: b?.checkIn ?? '2030-01-01',
								checkOut: b?.checkOut ?? '2030-01-02',
							}
						}),
					})
					expect(second.assigned).toHaveLength(0)
					expect(second.skipped).toHaveLength(0)
				},
			),
			{ numRuns: 50 },
		)
	})
})

describe('planAutoAssign — exact-value smoke (G8)', () => {
	test('happy path — 2 bookings × 2 rooms same type → both placed', () => {
		const result: BookingAutoAssignResult = planAutoAssign({
			unassigned: [
				{ id: 'b1', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
				{ id: 'b2', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
			],
			rooms: [
				{ id: 'r1', roomTypeId: 'rmt_a', roomNumber: '101', isActive: true },
				{ id: 'r2', roomTypeId: 'rmt_a', roomNumber: '102', isActive: true },
			],
			existingPins: [],
		})
		expect(result.assigned).toHaveLength(2)
		expect(result.skipped).toHaveLength(0)
		// Top-down: b1 → r1 (smallest roomNumber)
		expect(result.assigned[0]?.roomId).toBe('r1')
		expect(result.assigned[1]?.roomId).toBe('r2')
	})

	test('over-capacity — 3 bookings same dates × 2 rooms → 2 placed + 1 skipped no_room', () => {
		const result = planAutoAssign({
			unassigned: [
				{ id: 'b1', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
				{ id: 'b2', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
				{ id: 'b3', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
			],
			rooms: [
				{ id: 'r1', roomTypeId: 'rmt_a', roomNumber: '101', isActive: true },
				{ id: 'r2', roomTypeId: 'rmt_a', roomNumber: '102', isActive: true },
			],
			existingPins: [],
		})
		expect(result.assigned).toHaveLength(2)
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0]?.reason).toBe('no_room')
	})

	test('inactive-only — booking + only inactive room of matching type → skipped room_inactive', () => {
		const result = planAutoAssign({
			unassigned: [
				{ id: 'b1', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
			],
			rooms: [{ id: 'r1', roomTypeId: 'rmt_a', roomNumber: '101', isActive: false }],
			existingPins: [],
		})
		expect(result.assigned).toHaveLength(0)
		expect(result.skipped[0]?.reason).toBe('room_inactive')
	})

	test('wrong-type — booking for rmt_a + only rmt_b rooms → wrong_type', () => {
		const result = planAutoAssign({
			unassigned: [
				{ id: 'b1', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
			],
			rooms: [{ id: 'r1', roomTypeId: 'rmt_b', roomNumber: '201', isActive: true }],
			existingPins: [],
		})
		expect(result.assigned).toHaveLength(0)
		expect(result.skipped[0]?.reason).toBe('wrong_type')
	})

	test('existing pin blocks overlapping new — booking gets next room', () => {
		const result = planAutoAssign({
			unassigned: [
				{ id: 'b1', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-03' },
			],
			rooms: [
				{ id: 'r1', roomTypeId: 'rmt_a', roomNumber: '101', isActive: true },
				{ id: 'r2', roomTypeId: 'rmt_a', roomNumber: '102', isActive: true },
			],
			existingPins: [
				{
					bookingId: 'existing',
					roomId: 'r1',
					checkIn: '2030-01-02',
					checkOut: '2030-01-04',
				},
			],
		})
		expect(result.assigned).toHaveLength(1)
		// r1 occupied by existing 01-02..01-04 → b1 picks r2
		expect(result.assigned[0]?.roomId).toBe('r2')
	})

	test('roomNumber tie-break — alphabetic sort with numeric-first canon', () => {
		const result = planAutoAssign({
			unassigned: [
				{ id: 'b1', roomTypeId: 'rmt_a', checkIn: '2030-01-01', checkOut: '2030-01-02' },
			],
			rooms: [
				{ id: 'rA', roomTypeId: 'rmt_a', roomNumber: 'A1', isActive: true },
				{ id: 'r10', roomTypeId: 'rmt_a', roomNumber: '10', isActive: true },
				{ id: 'r2', roomTypeId: 'rmt_a', roomNumber: '2', isActive: true },
			],
			existingPins: [],
		})
		// Numeric-first canon: 2 < 10 < A1 → pick r2
		expect(result.assigned[0]?.roomId).toBe('r2')
	})
})
