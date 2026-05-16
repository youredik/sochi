import type { BookingAutoAssignResult } from '@horeca/shared'

/**
 * G8 (2026-05-16) — Interval-Partition Greedy room allocation pure module.
 *
 * Per Kleinberg-Tardos §4.1 canonical algorithm (verified 2026-05-16 research):
 * sort intervals (bookings) by start time (checkIn ASC) and assign each to
 * the first room which has no overlapping existing assignment. Top-down
 * `roomNumber ASC` tie-breaker matches Mews default canon.
 *
 * Complexity: O(N · K · D) where N = unassigned bookings, K = rooms, D =
 * average stay days. Acceptable for SMB scale (N≤200, K≤50, D≤30).
 *
 * Skip rules per Cloudbeds canon (verbatim from KB 2026-05-16):
 *   - room.isActive === false → skipped с reason 'room_inactive'
 *   - room.roomTypeId !== booking.roomTypeId → not even considered
 *   - all matching rooms occupied → skipped с reason 'no_room'
 *
 * Pure function (no I/O, no Date.now). Property-testable: random N×K
 * input MUST produce zero overlaps в output (canonical invariant).
 *
 * **Idempotency**: existing assignments (`existingPins`) NEVER mutated.
 * Re-run после partial allocation only places previously-unassigned.
 * Operator-trust canon — re-running auto-assign is non-destructive.
 */

export interface AutoAssignInput {
	/** Bookings без assignedRoomId (status=confirmed, propertyId-filtered). */
	readonly unassigned: ReadonlyArray<{
		readonly id: string
		readonly roomTypeId: string
		readonly checkIn: string
		readonly checkOut: string
	}>
	/** All rooms в property + isActive flag + roomNumber для top-down ordering. */
	readonly rooms: ReadonlyArray<{
		readonly id: string
		readonly roomTypeId: string
		readonly roomNumber: string
		readonly isActive: boolean
	}>
	/** Existing pins (status='confirmed' OR 'in_house') — drive overlap matrix. */
	readonly existingPins: ReadonlyArray<{
		readonly bookingId: string
		readonly roomId: string
		readonly checkIn: string
		readonly checkOut: string
	}>
}

/**
 * Date-range overlap predicate (exclusive-checkout convention): `[a1, a2)`
 * vs `[b1, b2)` overlap when `a1 < b2 && b1 < a2`. Lexicographic ISO date
 * strings compare correctly per YYYY-MM-DD format guarantee.
 */
function rangesOverlap(a1: string, a2: string, b1: string, b2: string): boolean {
	return a1 < b2 && b1 < a2
}

/**
 * `roomNumber` comparator: numeric-first sort (e.g. «101» < «102» < «201»)
 * с lexicographic fallback для non-numeric («A101», «B201»). Matches Mews
 * top-down canon (Mews docs allow custom override; we default к numeric).
 */
function compareRoomNumber(a: string, b: string): number {
	const aNum = Number(a)
	const bNum = Number(b)
	const aIsNum = !Number.isNaN(aNum)
	const bIsNum = !Number.isNaN(bNum)
	if (aIsNum && bIsNum) return aNum - bNum
	if (aIsNum) return -1 // numeric rooms first
	if (bIsNum) return 1
	return a.localeCompare(b)
}

export function planAutoAssign(input: AutoAssignInput): BookingAutoAssignResult {
	// Sort unassigned by checkIn ASC (Kleinberg-Tardos canonical). Tie-break
	// by id для deterministic output.
	const sortedUnassigned = [...input.unassigned].sort((a, b) => {
		if (a.checkIn !== b.checkIn) return a.checkIn < b.checkIn ? -1 : 1
		return a.id < b.id ? -1 : 1
	})

	// Build per-room occupancy from existing pins (deep-copy для mutation safety).
	const roomOccupancy = new Map<string, Array<{ checkIn: string; checkOut: string }>>()
	for (const pin of input.existingPins) {
		const arr = roomOccupancy.get(pin.roomId) ?? []
		arr.push({ checkIn: pin.checkIn, checkOut: pin.checkOut })
		roomOccupancy.set(pin.roomId, arr)
	}

	// Group rooms by roomTypeId for fast lookup + top-down ordering.
	const roomsByType = new Map<
		string,
		ReadonlyArray<{ id: string; roomNumber: string; isActive: boolean }>
	>()
	for (const room of input.rooms) {
		const arr = (roomsByType.get(room.roomTypeId) ?? []) as Array<{
			id: string
			roomNumber: string
			isActive: boolean
		}>
		arr.push({ id: room.id, roomNumber: room.roomNumber, isActive: room.isActive })
		roomsByType.set(room.roomTypeId, arr)
	}
	// Pre-sort per-type by roomNumber ASC (top-down canon).
	for (const [k, v] of roomsByType) {
		const sorted = [...v].sort((a, b) => compareRoomNumber(a.roomNumber, b.roomNumber))
		roomsByType.set(k, sorted)
	}

	const assigned: Array<{ bookingId: string; roomId: string }> = []
	const skipped: Array<{ bookingId: string; reason: 'no_room' | 'wrong_type' | 'room_inactive' }> =
		[]

	for (const booking of sortedUnassigned) {
		const candidates = roomsByType.get(booking.roomTypeId)
		if (!candidates || candidates.length === 0) {
			skipped.push({ bookingId: booking.id, reason: 'wrong_type' })
			continue
		}
		// Filter active rooms only.
		const activeCandidates = candidates.filter((r) => r.isActive)
		if (activeCandidates.length === 0) {
			skipped.push({ bookingId: booking.id, reason: 'room_inactive' })
			continue
		}
		// Find first room без overlap.
		let pickedRoomId: string | null = null
		for (const room of activeCandidates) {
			const pins = roomOccupancy.get(room.id) ?? []
			const hasOverlap = pins.some((pin) =>
				rangesOverlap(booking.checkIn, booking.checkOut, pin.checkIn, pin.checkOut),
			)
			if (!hasOverlap) {
				pickedRoomId = room.id
				break
			}
		}
		if (!pickedRoomId) {
			skipped.push({ bookingId: booking.id, reason: 'no_room' })
			continue
		}
		assigned.push({ bookingId: booking.id, roomId: pickedRoomId })
		// Mark room occupied for subsequent iterations.
		const arr = roomOccupancy.get(pickedRoomId) ?? []
		arr.push({ checkIn: booking.checkIn, checkOut: booking.checkOut })
		roomOccupancy.set(pickedRoomId, arr)
	}

	return { assigned, skipped }
}
