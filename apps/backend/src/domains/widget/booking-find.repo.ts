/**
 * Booking-find repo (M9.widget.5 / A3.1.c).
 *
 * Encapsulates DB queries для timing-safe booking-find flow per architecture
 * canon (`no-routes-to-db` depcruise rule — routes must go through repo).
 *
 * Operations:
 *   - `lookupBookingByReferenceAndEmail(tenantId, reference, emailLower)` —
 *     race-safe lookup; returns `{ bookingId, propertyName, senderInn,
 *     senderOrgName, guestEmail }` if booking exists AND guest email matches
 *     (case-insensitive trim), null otherwise. Snapshot-isolation reads.
 *   - `insertMagicLinkOutbox(...)` — writes notificationOutbox row с
 *     pre-rendered subject + bodyText (booking_magic_link kind). Existing
 *     dispatcher CDC consumer picks up + sends.
 */

import type { sql as SQL } from '../../db/index.ts'
import { NULL_TEXT, NULL_TIMESTAMP } from '../../db/ydb-helpers.ts'

type SqlInstance = typeof SQL

interface BookingDbRow {
	id: string
	tenantId: string
	primaryGuestId: string
	propertyId: string
}

interface PropertyDbRow {
	id: string
	name: string
}

interface GuestEmailDbRow {
	email: string | null
}

interface OrgProfileDbRow {
	organizationId: string
	inn: string | null
}

interface OrgDbRow {
	name: string
}

export interface BookingFindMatch {
	readonly bookingId: string
	readonly propertyName: string
	readonly senderInn: string
	readonly senderOrgName: string
	readonly guestEmail: string
}

export interface InsertMagicLinkOutboxInput {
	readonly tenantId: string
	readonly notificationId: string
	readonly bookingId: string
	readonly recipientEmail: string
	readonly subject: string
	readonly bodyText: string
	readonly payloadJson: string
	readonly dedupKey: string
	readonly now: Date
}

export function createBookingFindRepo(sql: SqlInstance) {
	return {
		/**
		 * Race-safe booking + guest + property + org lookup. Returns null если
		 * any link missing OR email mismatch. Cross-tenant isolation enforced
		 * via tenantId filter on EVERY query.
		 *
		 * NB: Multiple queries (booking → guest → property → org → profile).
		 * Caller (booking-find.routes.ts) wraps full handler в Promise.allSettled
		 * + Math.max padding для timing-safe canon — variable query count
		 * normalized к fixed total response time.
		 */
		async lookupBookingByReferenceAndEmail(
			tenantId: string,
			reference: string,
			emailLower: string,
		): Promise<BookingFindMatch | null> {
			const [bookingRows = []] = await sql<BookingDbRow[]>`
				SELECT id, tenantId, primaryGuestId, propertyId
				FROM booking
				WHERE tenantId = ${tenantId} AND id = ${reference}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const booking = bookingRows[0]
			if (!booking) return null

			const [guestRows = []] = await sql<GuestEmailDbRow[]>`
				SELECT email FROM guest
				WHERE tenantId = ${tenantId} AND id = ${booking.primaryGuestId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const guestEmail = guestRows[0]?.email
			if (!guestEmail) return null
			if (guestEmail.trim().toLowerCase() !== emailLower) return null

			const [propRows = []] = await sql<PropertyDbRow[]>`
				SELECT id, name FROM property
				WHERE tenantId = ${tenantId} AND id = ${booking.propertyId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const property = propRows[0]
			if (!property) return null

			const [orgRows = []] = await sql<OrgDbRow[]>`
				SELECT name FROM organization WHERE id = ${tenantId} LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const org = orgRows[0]
			if (!org) return null

			const [profileRows = []] = await sql<OrgProfileDbRow[]>`
				SELECT organizationId, inn FROM organizationProfile WHERE organizationId = ${tenantId} LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const profile = profileRows[0]

			return {
				bookingId: booking.id,
				propertyName: property.name,
				senderInn: profile?.inn ?? '0000000000',
				senderOrgName: org.name,
				guestEmail,
			}
		},

		/**
		 * Insert notificationOutbox row для magic-link delivery. Pre-rendered
		 * subject + bodyText (caller invokes renderTemplate). Existing dispatcher
		 * CDC consumer picks up + sends through email factory (Postbox/Mailpit
		 * per APP_MODE).
		 */
		async insertMagicLinkOutbox(input: InsertMagicLinkOutboxInput): Promise<void> {
			await sql`
				UPSERT INTO notificationOutbox (
					\`tenantId\`, \`id\`,
					\`kind\`, \`channel\`, \`recipient\`, \`recipientKind\`,
					\`subject\`, \`bodyText\`, \`payloadJson\`,
					\`status\`,
					\`sentAt\`, \`failedAt\`, \`failureReason\`, \`retryCount\`,
					\`sourceObjectType\`, \`sourceObjectId\`, \`sourceEventDedupKey\`,
					\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
				) VALUES (
					${input.tenantId}, ${input.notificationId},
					${'booking_magic_link'}, ${'email'}, ${input.recipientEmail}, ${'guest'},
					${input.subject}, ${input.bodyText}, ${input.payloadJson},
					${'pending'},
					${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${0},
					${'booking'}, ${input.bookingId}, ${input.dedupKey},
					${input.now}, ${input.now}, ${'system:booking_find'}, ${'system:booking_find'}
				)
			`.idempotent(true)
		},
	}
}

export type BookingFindRepo = ReturnType<typeof createBookingFindRepo>
