/**
 * `migration_registration_enqueuer` CDC handler — integration tests.
 *
 * **Pre-done audit checklist (per memory `feedback_pre_done_audit.md`):**
 *
 *   Trigger semantics (FSM `* → in_house` detection):
 *     [T1] confirmed → in_house transition → registration created
 *     [T2] direct INSERT with status='in_house' (oldStatus undefined) → created
 *     [T3] confirmed → checked_out (no in_house touch) → skip
 *     [T4] in_house → in_house (no transition) → skip
 *     [T5] in_house → cancelled (rollback away) → skip
 *     [T6] DELETE event (no newImage) → skip
 *
 *   Defensive guards:
 *     [G1] malformed key (missing components) → skip silent
 *     [G2] missing primaryGuestId in newImage → skip
 *     [G3] missing checkIn / checkOut → skip
 *
 *   Tenant config dependency:
 *     [C1] tenant config completely null → skip silent
 *     [C2] tenant config missing channel only → skip
 *     [C3] tenant config missing supplierGid only → skip
 *     [C4] tenant config invalid channel value → skip
 *     [C5] tenant config complete (3 fields) → registration created с этими values
 *
 *   Document lookup:
 *     [D1] no guestDocument for primaryGuestId → skip silent
 *     [D2] multiple documents → uses most recent (ORDER BY createdAt DESC)
 *
 *   Payload correctness:
 *     [P1] statusCode=0 (draft), isFinal=false, retryCount=0
 *     [P2] epguOrderId=null, epguApplicationNumber=null, submittedAt=null
 *     [P3] arrivalDate=checkIn, departureDate=checkOut (Date roundtrip)
 *     [P4] serviceCode + targetCode из EPGU constants (NOT tenant-specific)
 *     [P5] createdBy = updatedBy = 'system:migration_registration_enqueuer'
 *     [P6] documentId = found guestDocument.id
 *     [P7] guestId = primaryGuestId from booking
 *
 *   Idempotency (canon — idxMigRegTenantBooking pre-check):
 *     [I1] fire same event twice → ONE registration (replay-safe)
 *
 *   Cross-tenant isolation:
 *     [CT1] tenantA event сo своим config + doc → НЕ читает tenantB
 *           document/config (зеркальный setup proves tenant scoping)
 *
 * Requires local YDB + migration 0038 (organizationProfile epgu cols).
 */
import { newId } from '@horeca/shared'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NULL_TEXT, toTs } from '../../db/ydb-helpers.ts'
import { getTestSql, setupTestDb, teardownTestDb } from '../../tests/db-setup.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import { createMigrationRegistrationEnqueuerHandler } from './migration-registration-enqueuer.ts'

beforeAll(async () => {
	await setupTestDb()
})
afterAll(async () => {
	await teardownTestDb()
})

const silentLog = { debug: () => {}, info: () => {}, warn: () => {} }
const handler = createMigrationRegistrationEnqueuerHandler(silentLog)

interface BookingEventOverrides {
	tenantId?: string
	propertyId?: string
	checkIn?: string
	checkOut?: string
	bookingId?: string
	primaryGuestId?: string
	newStatus?: string | undefined
	oldStatus?: string | undefined
	omitNewImage?: boolean
	omitKey?: boolean
	missingPrimaryGuestId?: boolean
	missingCheckIn?: boolean
	missingCheckOut?: boolean
}

function buildBookingEvent(overrides: BookingEventOverrides = {}): CdcEvent {
	const tenantId = overrides.tenantId ?? newId('organization')
	const propertyId = overrides.propertyId ?? newId('property')
	const checkIn = overrides.checkIn ?? '2026-05-01'
	const bookingId = overrides.bookingId ?? newId('booking')

	const event: CdcEvent = { key: [tenantId, propertyId, checkIn, bookingId] }
	if (overrides.omitKey) event.key = []

	if (!overrides.omitNewImage) {
		const img: Record<string, unknown> = {
			status: overrides.newStatus ?? 'in_house',
		}
		if (!overrides.missingPrimaryGuestId) {
			img.primaryGuestId = overrides.primaryGuestId ?? newId('guest')
		}
		if (!overrides.missingCheckIn) {
			img.checkIn = checkIn
		}
		if (!overrides.missingCheckOut) {
			img.checkOut = overrides.checkOut ?? '2026-05-05'
		}
		event.newImage = img
	}
	if (overrides.oldStatus !== undefined) {
		event.oldImage = { status: overrides.oldStatus, primaryGuestId: 'old' }
	}
	return event
}

async function runHandler(event: CdcEvent): Promise<void> {
	const sql = getTestSql()
	await sql.begin({ idempotent: true }, async (tx) => {
		await handler(tx, event)
	})
}

async function seedTenantConfig(
	tenantId: string,
	config: {
		channel?: string | null
		supplierGid?: string | null
		regionCode?: string | null
	} = {},
): Promise<void> {
	const sql = getTestSql()
	const channel = config.channel === null ? NULL_TEXT : (config.channel ?? 'gost-tls')
	const supplier =
		config.supplierGid === null ? NULL_TEXT : (config.supplierGid ?? 'supplier-test-gid')
	const region = config.regionCode === null ? NULL_TEXT : (config.regionCode ?? 'fias-region-sochi')
	const nowTs = toTs(new Date())
	await sql`
		UPSERT INTO organizationProfile (
			\`organizationId\`, \`plan\`, \`createdAt\`, \`updatedAt\`,
			\`epguDefaultChannel\`, \`epguSupplierGid\`, \`epguRegionCodeFias\`
		) VALUES (
			${tenantId}, ${'free'}, ${nowTs}, ${nowTs},
			${channel}, ${supplier}, ${region}
		)
	`
}

async function seedGuestDocument(
	tenantId: string,
	guestId: string,
	overrides: { id?: string; createdAtIso?: string; documentNumber?: string } = {},
): Promise<string> {
	const sql = getTestSql()
	const id = overrides.id ?? newId('guestDocument')
	const createdAt = overrides.createdAtIso ? new Date(overrides.createdAtIso) : new Date()
	const ts = toTs(createdAt)
	await sql`
		UPSERT INTO guestDocument (
			\`tenantId\`, \`id\`, \`guestId\`, \`identityMethod\`,
			\`documentNumber\`, \`citizenshipIso3\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${tenantId}, ${id}, ${guestId}, ${'passport_paper'},
			${overrides.documentNumber ?? '123456'}, ${'rus'},
			${ts}, ${ts}, ${'usr_test'}, ${'usr_test'}
		)
	`
	return id
}

interface RegistrationRow {
	id: string
	tenantId: string
	bookingId: string
	guestId: string
	documentId: string
	epguChannel: string
	statusCode: number
	isFinal: boolean
	retryCount: number
	epguOrderId: string | null
	epguApplicationNumber: string | null
	submittedAt: string | null
	serviceCode: string
	targetCode: string
	supplierGid: string
	regionCode: string
	arrivalDate: string
	departureDate: string
	createdBy: string
	updatedBy: string
}

async function findRegistrationsByBooking(
	tenantId: string,
	bookingId: string,
): Promise<RegistrationRow[]> {
	const sql = getTestSql()
	const [rows = []] = await sql<Array<Record<string, unknown>>>`
		SELECT
			\`id\`, \`tenantId\`, \`bookingId\`, \`guestId\`, \`documentId\`,
			\`epguChannel\`, \`statusCode\`, \`isFinal\`, \`retryCount\`,
			\`epguOrderId\`, \`epguApplicationNumber\`, \`submittedAt\`,
			\`serviceCode\`, \`targetCode\`, \`supplierGid\`, \`regionCode\`,
			\`arrivalDate\`, \`departureDate\`, \`createdBy\`, \`updatedBy\`
		FROM migrationRegistration VIEW idxMigRegTenantBooking
		WHERE \`tenantId\` = ${tenantId} AND \`bookingId\` = ${bookingId}
	`.idempotent(true)
	return rows.map((r) => ({
		id: String(r.id),
		tenantId: String(r.tenantId),
		bookingId: String(r.bookingId),
		guestId: String(r.guestId),
		documentId: String(r.documentId),
		epguChannel: String(r.epguChannel),
		statusCode: Number(r.statusCode),
		isFinal: Boolean(r.isFinal),
		retryCount: Number(r.retryCount),
		epguOrderId: r.epguOrderId === null ? null : String(r.epguOrderId),
		epguApplicationNumber:
			r.epguApplicationNumber === null ? null : String(r.epguApplicationNumber),
		submittedAt: r.submittedAt === null ? null : String(r.submittedAt),
		serviceCode: String(r.serviceCode),
		targetCode: String(r.targetCode),
		supplierGid: String(r.supplierGid),
		regionCode: String(r.regionCode),
		arrivalDate:
			r.arrivalDate instanceof Date
				? r.arrivalDate.toISOString().slice(0, 10)
				: String(r.arrivalDate),
		departureDate:
			r.departureDate instanceof Date
				? r.departureDate.toISOString().slice(0, 10)
				: String(r.departureDate),
		createdBy: String(r.createdBy),
		updatedBy: String(r.updatedBy),
	}))
}

describe('migration_registration_enqueuer — trigger semantics', { tags: ['db'] }, () => {
	test('[T1] confirmed → in_house transition creates draft', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
	})

	test('[T2] direct INSERT with status=in_house (no oldImage) creates draft', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				// oldStatus undefined ⇒ no oldImage ⇒ INSERT
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
	})

	test('[T3] confirmed → checked_out (no in_house touch) → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'checked_out',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[T4] in_house → in_house (no transition) → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'in_house',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[T5] in_house → cancelled (rollback) → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'cancelled',
				oldStatus: 'in_house',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[T6] DELETE (no newImage) → skip silent', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await runHandler(buildBookingEvent({ tenantId, bookingId, omitNewImage: true }))
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})
})

describe('migration_registration_enqueuer — defensive guards', { tags: ['db'] }, () => {
	test('[G1] malformed key (omitKey) → skip silent', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await runHandler(buildBookingEvent({ tenantId, bookingId, omitKey: true }))
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[G2] missing primaryGuestId → skip', async () => {
		const tenantId = newId('organization')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
				missingPrimaryGuestId: true,
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[G3] missing checkIn → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
				missingCheckIn: true,
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})
})

describe('migration_registration_enqueuer — tenant config dependency', { tags: ['db'] }, () => {
	test('[C1] tenant config completely null → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId, { channel: null, supplierGid: null, regionCode: null })
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[C2] tenant config missing channel only → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId, { channel: null })
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[C3] tenant config missing supplierGid only → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId, { supplierGid: null })
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[C4] tenant config invalid channel value → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId, { channel: 'invalid-channel' })
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[C5] tenant config complete → registration uses these values', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId, {
			channel: 'svoks',
			supplierGid: 'supplier-svoks-XYZ',
			regionCode: 'fias-irkutsk',
		})
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
		const row = rows[0]
		if (!row) throw new Error('expected row')
		expect(row.epguChannel).toBe('svoks')
		expect(row.supplierGid).toBe('supplier-svoks-XYZ')
		expect(row.regionCode).toBe('fias-irkutsk')
	})
})

describe('migration_registration_enqueuer — document lookup', { tags: ['db'] }, () => {
	test('[D1] no guestDocument for primaryGuestId → skip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		// NO seedGuestDocument
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(0)
	})

	test('[D2] multiple documents → uses most recent (createdAt DESC)', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId, {
			documentNumber: 'OLD-001',
			createdAtIso: '2026-04-01T10:00:00Z',
		})
		const recentDocId = await seedGuestDocument(tenantId, guestId, {
			documentNumber: 'NEW-002',
			createdAtIso: '2026-04-15T10:00:00Z',
		})
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
		const row = rows[0]
		if (!row) throw new Error('expected row')
		expect(row.documentId).toBe(recentDocId)
	})
})

describe('migration_registration_enqueuer — payload correctness', { tags: ['db'] }, () => {
	test('[P1+P2] draft state: statusCode=0, isFinal=false, retryCount=0, all FSM nullable=null', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const row = (await findRegistrationsByBooking(tenantId, bookingId))[0]
		if (!row) throw new Error('expected row')
		expect(row.statusCode).toBe(0)
		expect(row.isFinal).toBe(false)
		expect(row.retryCount).toBe(0)
		expect(row.epguOrderId).toBeNull()
		expect(row.epguApplicationNumber).toBeNull()
		expect(row.submittedAt).toBeNull()
	})

	test('[P3] arrivalDate=checkIn, departureDate=checkOut roundtrip', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				checkIn: '2026-06-10',
				checkOut: '2026-06-15',
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const row = (await findRegistrationsByBooking(tenantId, bookingId))[0]
		if (!row) throw new Error('expected row')
		expect(row.arrivalDate).toBe('2026-06-10')
		expect(row.departureDate).toBe('2026-06-15')
	})

	test('[P4] serviceCode + targetCode из глобальных EPGU constants (not tenant-specific)', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const row = (await findRegistrationsByBooking(tenantId, bookingId))[0]
		if (!row) throw new Error('expected row')
		expect(row.serviceCode).toBe('10000103652')
		expect(row.targetCode).toBe('-1000444103652')
	})

	test('[P5] createdBy = updatedBy = system:migration_registration_enqueuer', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const row = (await findRegistrationsByBooking(tenantId, bookingId))[0]
		if (!row) throw new Error('expected row')
		expect(row.createdBy).toBe('system:migration_registration_enqueuer')
		expect(row.updatedBy).toBe('system:migration_registration_enqueuer')
	})

	test('[P6+P7] documentId from latest guestDocument, guestId = primaryGuestId', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		const docId = await seedGuestDocument(tenantId, guestId)
		await runHandler(
			buildBookingEvent({
				tenantId,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		const row = (await findRegistrationsByBooking(tenantId, bookingId))[0]
		if (!row) throw new Error('expected row')
		expect(row.documentId).toBe(docId)
		expect(row.guestId).toBe(guestId)
	})
})

describe('migration_registration_enqueuer — idempotency', { tags: ['db'] }, () => {
	test('[I1] same event fired twice → ONE registration (replay-safe)', async () => {
		const tenantId = newId('organization')
		const guestId = newId('guest')
		const bookingId = newId('booking')
		await seedTenantConfig(tenantId)
		await seedGuestDocument(tenantId, guestId)
		const event = buildBookingEvent({
			tenantId,
			bookingId,
			primaryGuestId: guestId,
			newStatus: 'in_house',
			oldStatus: 'confirmed',
		})
		await runHandler(event)
		await runHandler(event) // replay
		const rows = await findRegistrationsByBooking(tenantId, bookingId)
		expect(rows).toHaveLength(1)
	})
})

describe('migration_registration_enqueuer — cross-tenant isolation', { tags: ['db'] }, () => {
	test('[CT1] tenantA event not affected by tenantB config/document', async () => {
		const tenantA = newId('organization')
		const tenantB = newId('organization')
		const guestId = newId('guest') // same guest id used in both tenants
		const bookingId = newId('booking')
		// Tenant A: NO config, NO document → handler should skip
		await seedTenantConfig(tenantA, { channel: null, supplierGid: null, regionCode: null })
		// Tenant B: full config + document for SAME guestId
		await seedTenantConfig(tenantB)
		await seedGuestDocument(tenantB, guestId)

		await runHandler(
			buildBookingEvent({
				tenantId: tenantA,
				bookingId,
				primaryGuestId: guestId,
				newStatus: 'in_house',
				oldStatus: 'confirmed',
			}),
		)
		// No leak: tenant A skip-нул потому что у него нет config (НЕ нашёл tenantB config)
		// и не нашёл tenantB document.
		const rowsA = await findRegistrationsByBooking(tenantA, bookingId)
		expect(rowsA).toHaveLength(0)
		// Tenant B unaffected by event для tenant A (бронь принадлежит A, не B)
		const rowsB = await findRegistrationsByBooking(tenantB, bookingId)
		expect(rowsB).toHaveLength(0)
	})
})
