import type {
	PropertyBlock,
	PropertyBlockCreateInput,
	PropertyBlockUpdateInput,
} from '@horeca/shared'
import type { BookingRepo } from '../booking/booking.repo.ts'
import type { PropertyService } from '../property/property.service.ts'
import type { RoomService } from '../room/room.service.ts'
import type { PropertyBlockRepo } from './property-block.repo.ts'
import {
	PropertyBlockBookingConflictError,
	PropertyBlockNotFoundError,
	PropertyBlockPastImmutableError,
	PropertyNotFoundError,
} from '../../errors/domain.ts'

interface BlockCreateContext {
	actorUserId: string
}

interface BlockCreateResult {
	created: PropertyBlock[]
	skipped: Array<{
		roomId: string
		reason: 'overlap_block' | 'room_inactive' | 'wrong_property' | 'cas_race'
	}>
}

function todayIso(): string {
	return new Date().toISOString().slice(0, 10)
}

/**
 * Property-block service. Multi-room create с pre-validate pass +
 * per-row write canon (per `[[interval-partition-greedy-canon]]`).
 *
 * Block-over-booking semantics: HARD-BLOCK (Apaleo/OPERA/Cloudbeds canon).
 * If ANY of the requested rooms has an active booking overlap, ALL fail
 * — operator must remove the booking first. This protects clean denomin-
 * ator для 2% туристический налог reporting (Сочи 2026) + RU regulator
 * inventory rules (every blocked night must have a documented reason).
 *
 * Block-over-existing-block: silent skip in the result.skipped list
 * (operator clarity — partial-success canon, not all-or-nothing).
 */
export function createPropertyBlockService(deps: {
	blockRepo: PropertyBlockRepo
	bookingRepo: BookingRepo
	propertyService: PropertyService
	roomService: RoomService
}) {
	return {
		/**
		 * Create blocks for one or more rooms in a single operator action.
		 *
		 * Flow:
		 *  1. Verify property belongs к tenant
		 *  2. For each room: verify it belongs к property + roomTypeId fixed
		 *  3. PRE-validate booking overlap для ALL rooms (hard-block-fail-all)
		 *  4. For each room: per-row tx — re-check existing-block overlap,
		 *     insert if clear, skip if exists (idempotent)
		 *
		 * Returns `created` (successful inserts) + `skipped` (existing-block
		 * overlap or race conditions).
		 */
		async createBlocks(
			tenantId: string,
			propertyId: string,
			input: PropertyBlockCreateInput,
			ctx: BlockCreateContext,
		): Promise<BlockCreateResult> {
			const property = await deps.propertyService.getById(tenantId, propertyId)
			if (!property) throw new PropertyNotFoundError(propertyId)

			// Dedupe roomIds — operator might have duplicate selections.
			const uniqueRoomIds = Array.from(new Set(input.roomIds))

			// Step 1: resolve all rooms; collect those that are wrong-property
			// or inactive into skipped (don't fail-all on these — operator
			// could have stale cache; let them see partial result).
			const rooms = await Promise.all(
				uniqueRoomIds.map(async (rid) => ({
					id: rid,
					room: await deps.roomService.getById(tenantId, rid),
				})),
			)
			const validRoomIds: string[] = []
			const skipped: BlockCreateResult['skipped'] = []
			for (const { id, room } of rooms) {
				if (!room || room.propertyId !== propertyId) {
					skipped.push({ roomId: id, reason: 'wrong_property' })
					continue
				}
				if (!room.isActive) {
					skipped.push({ roomId: id, reason: 'room_inactive' })
					continue
				}
				validRoomIds.push(id)
			}
			if (validRoomIds.length === 0) {
				return { created: [], skipped }
			}

			// Step 2: PRE-validate booking overlap for all valid rooms.
			// HARD-BLOCK if any has a booking — fail entire op (Apaleo canon).
			const bookingConflictRoomIds: string[] = []
			for (const rid of validRoomIds) {
				const overlapping = await deps.bookingRepo.findOverlappingBookingsByRoom(
					tenantId,
					rid,
					input.startDate,
					input.endDate,
				)
				if (overlapping.length > 0) bookingConflictRoomIds.push(rid)
			}
			if (bookingConflictRoomIds.length > 0) {
				throw new PropertyBlockBookingConflictError(bookingConflictRoomIds)
			}

			// Step 3: per-room insert. Existing-block overlap → skip (silent).
			// Race: another operator creates conflicting block between our
			// check and insert → caught as `cas_race` skipped.
			const created: PropertyBlock[] = []
			for (const rid of validRoomIds) {
				const existing = await deps.blockRepo.findOverlappingByRoom(
					tenantId,
					rid,
					input.startDate,
					input.endDate,
				)
				if (existing.length > 0) {
					skipped.push({ roomId: rid, reason: 'overlap_block' })
					continue
				}
				try {
					const block = await deps.blockRepo.create(
						tenantId,
						propertyId,
						rid,
						input.startDate,
						input.endDate,
						input.reason,
						input.comment ?? null,
						ctx.actorUserId,
					)
					created.push(block)
				} catch {
					skipped.push({ roomId: rid, reason: 'cas_race' })
				}
			}
			return { created, skipped }
		},

		async listByPropertyWindow(
			tenantId: string,
			propertyId: string,
			from: string,
			to: string,
		): Promise<PropertyBlock[]> {
			return await deps.blockRepo.listByPropertyWindow(tenantId, propertyId, from, to)
		},

		async getById(tenantId: string, id: string): Promise<PropertyBlock | null> {
			return await deps.blockRepo.getById(tenantId, id)
		},

		/**
		 * Update mutable fields. Enforces past-immutability canon: if
		 * `endDate` is being changed AND new endDate < today AND new endDate
		 * < current endDate (i.e. SHRINKING into the past) → reject. Future-
		 * extension OK. TravelLine immutable-past canon — protects house-
		 * keeping records from historical revisionism.
		 *
		 * If dates change AND new range introduces a booking overlap →
		 * throw PropertyBlockBookingConflictError (block-over-booking).
		 */
		async update(
			tenantId: string,
			id: string,
			patch: PropertyBlockUpdateInput,
		): Promise<PropertyBlock> {
			const current = await deps.blockRepo.getById(tenantId, id)
			if (!current) throw new PropertyBlockNotFoundError(id)

			const newStartDate = patch.startDate ?? current.startDate
			const newEndDate = patch.endDate ?? current.endDate
			const today = todayIso()

			// Past-immutable: reject shrinking endDate into past
			if (patch.endDate !== undefined && patch.endDate < today && patch.endDate < current.endDate) {
				throw new PropertyBlockPastImmutableError()
			}

			// Re-validate booking overlap if dates changed
			if (patch.startDate !== undefined || patch.endDate !== undefined) {
				const overlapping = await deps.bookingRepo.findOverlappingBookingsByRoom(
					tenantId,
					current.roomId,
					newStartDate,
					newEndDate,
				)
				if (overlapping.length > 0) {
					throw new PropertyBlockBookingConflictError([current.roomId])
				}
			}

			return await deps.blockRepo.update(tenantId, id, patch)
		},

		async delete(tenantId: string, id: string): Promise<boolean> {
			return await deps.blockRepo.delete(tenantId, id)
		},
	}
}

// type export omitted — no external consumer needs the inferred ReturnType
// (factory file imports the function directly). Add export back если когда-нибудь
// internal service composition needs the type annotation.
