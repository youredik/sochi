/**
 * `migration_registration_enqueuer` CDC handler — listens on
 * `booking/booking_events` and creates a draft migrationRegistration row
 * when a booking transitions INTO `in_house` (check-in completed).
 *
 * ## Why `in_house`, not `confirmed`
 *
 * Постановление №1668 + research/epgu-rkl.md §2: middle размещения
 * obязано отправить уведомление в МВД ОВМ В ТЕЧЕНИЕ 24 ЧАСОВ С МОМЕНТА
 * ЗАСЕЛЕНИЯ (не с момента подтверждения брони). Booking_confirmed может
 * происходить за недели до приезда — в этот момент:
 *   * нет documentId (NOT NULL в migrationRegistration) — гость ещё не
 *     приехал и не сдал документ на сканирование
 *   * нет смысла обращаться к Контур.ФМС РКЛ — гость ещё не присутствует
 *
 * Check-in (`booking.status='in_house'`) — корректный domain trigger:
 *   * documentId уже создан фронт-десковским flow (passport scan → POST
 *     /guests/:id/documents → INSERT guestDocument BEFORE check-in button)
 *   * 24-часовый дедлайн стартует именно от check-in момента
 *   * RKL pre-check (М8.A.5.submit) теперь имеет смысл — гость физически здесь
 *
 * ## Trigger semantics
 *
 *   Fires ONLY on UPDATE events с FSM transition `* → in_house`.
 *   - INSERT direct status='in_house' (rare manual ops case) → fires
 *     (oldStatus undefined ≠ 'in_house', newStatus 'in_house')
 *   - UPDATE oldStatus='confirmed' → newStatus='in_house' → fires (canonical)
 *   - UPDATE oldStatus='in_house' → newStatus='in_house' → skip (no transition)
 *   - UPDATE newStatus !== 'in_house' → skip
 *   - DELETE → skip
 *
 * ## Required tenant config (organizationProfile, migration 0038)
 *
 *   Все три поля должны быть NOT NULL — иначе handler graceful-skips
 *   с warn-log:
 *   - epguDefaultChannel    — gost-tls | svoks | proxy-via-partner
 *   - epguSupplierGid       — UUID issued by МВД ОВМ
 *   - epguRegionCodeFias    — ФИАС code региона
 *
 *   Если хотя бы одно поле NULL — tenant ещё не прошёл МВД ОВМ onboarding,
 *   handler пропускает создание registration (operator может создать
 *   manually позже через POST /api/v1/migration-registrations).
 *
 * ## Document lookup
 *
 *   Пытается найти SAMое recent guestDocument для booking.primaryGuestId
 *   (ORDER BY createdAt DESC LIMIT 1) через VIEW idxGuestDocumentTenantGuest.
 *   Если документа нет — graceful skip с warn (frontend invariant: passport
 *   scan должен происходить ДО нажатия check-in кнопки в M8.A.6 UI).
 *
 * ## Idempotency
 *
 *   Pre-check VIEW idxMigRegTenantBooking ON (tenantId, bookingId):
 *   если row existуществует для этого booking — skip. Race scenario
 *   (replay одного и того же check-in event) → второй consumer видит row
 *   первого и skip-ит.
 *
 * ## Why raw SQL not service.enqueue()
 *
 *   service.enqueue() делает RKL pre-check через deps.rkl.check() —
 *   это **сейчас** не подходящий момент (check-in только что произошёл,
 *   passport только что отсканирован, RKL должен быть на этапе SUBMIT,
 *   а не enqueue). При migration в M8.A.5.submit refactor service.enqueue
 *   тоже изменится — RKL переедет в submit().
 *   Дополнительно: вызов service.enqueue из CDC handler nested two
 *   `sql.begin` (consumer outer + repo.create inner) → YDB rejects с
 *   TRANSACTION_LOCKS_INVALIDATED. CDC handlers project state directly
 *   через `tx`. Same canon как `folio_creator`, `refund_creator`.
 */

import {
	EPGU_SERVICE_CODE_MIGRATION_REGISTRATION,
	EPGU_STATUS_CODES,
	EPGU_TARGET_CODE_MIGRATION_REGISTRATION,
	type EpguChannel,
	newId,
} from '@horeca/shared'
import type { TX } from '@ydbjs/query'
import { dateFromIso, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from '../../db/ydb-helpers.ts'
import type { CdcEvent } from '../cdc-handlers.ts'
import type { HandlerLogger } from './refund-creator.ts'

const ENQUEUER_ACTOR_ID = 'system:migration_registration_enqueuer'

interface TenantEpguConfig {
	readonly epguDefaultChannel: EpguChannel
	readonly epguSupplierGid: string
	readonly epguRegionCodeFias: string
}

async function loadTenantConfig(tx: TX, tenantId: string): Promise<TenantEpguConfig | null> {
	const [rows = []] = await tx<
		Array<{
			epguDefaultChannel: string | null
			epguSupplierGid: string | null
			epguRegionCodeFias: string | null
		}>
	>`
		SELECT \`epguDefaultChannel\`, \`epguSupplierGid\`, \`epguRegionCodeFias\`
		FROM organizationProfile
		WHERE \`organizationId\` = ${tenantId}
		LIMIT 1
	`
	const row = rows[0]
	if (!row) return null
	const channel = row.epguDefaultChannel
	const supplierGid = row.epguSupplierGid
	const regionCode = row.epguRegionCodeFias
	if (!channel || !supplierGid || !regionCode) return null
	if (channel !== 'gost-tls' && channel !== 'svoks' && channel !== 'proxy-via-partner') return null
	return {
		epguDefaultChannel: channel as EpguChannel,
		epguSupplierGid: supplierGid,
		epguRegionCodeFias: regionCode,
	}
}

async function findMostRecentDocument(
	tx: TX,
	tenantId: string,
	guestId: string,
): Promise<string | null> {
	const [rows = []] = await tx<Array<{ id: string }>>`
		SELECT \`id\` FROM guestDocument VIEW idxGuestDocumentTenantGuest
		WHERE \`tenantId\` = ${tenantId} AND \`guestId\` = ${guestId}
		ORDER BY \`createdAt\` DESC
		LIMIT 1
	`
	return rows[0]?.id ?? null
}

async function migrationRegistrationExists(
	tx: TX,
	tenantId: string,
	bookingId: string,
): Promise<boolean> {
	const [rows = []] = await tx<Array<{ x: number }>>`
		SELECT 1 AS x FROM migrationRegistration VIEW idxMigRegTenantBooking
		WHERE \`tenantId\` = ${tenantId} AND \`bookingId\` = ${bookingId}
		LIMIT 1
	`
	return rows.length > 0
}

/**
 * Build a CDC projection that creates draft migrationRegistration rows on
 * booking check-in.
 */
export function createMigrationRegistrationEnqueuerHandler(log: HandlerLogger) {
	return async (tx: TX, event: CdcEvent): Promise<void> => {
		// Need both images for status-transition detection.
		if (!event.newImage) return // DELETE
		const newStatus = event.newImage.status as string | undefined
		const oldStatus = event.oldImage?.status as string | undefined

		// Fire only on transition INTO 'in_house'. INSERT events have undefined
		// oldStatus → fires if newStatus='in_house' (manual direct-to-in_house ops).
		if (newStatus !== 'in_house') return
		if (oldStatus === 'in_house') return // no actual transition

		// Booking PK is 4D: (tenantId, propertyId, checkIn, id) — see migration 0004.
		const key = event.key ?? []
		if (
			key[0] === undefined ||
			key[1] === undefined ||
			key[2] === undefined ||
			key[3] === undefined
		) {
			log.warn({ key }, 'migration_registration_enqueuer: malformed booking event key — skipping')
			return
		}
		const tenantId = String(key[0])
		const bookingId = String(key[3])

		const primaryGuestId = event.newImage.primaryGuestId
		if (typeof primaryGuestId !== 'string' || primaryGuestId.length === 0) {
			log.warn(
				{ tenantId, bookingId },
				'migration_registration_enqueuer: missing primaryGuestId — skipping',
			)
			return
		}

		const checkInIso = event.newImage.checkIn
		const checkOutIso = event.newImage.checkOut
		if (typeof checkInIso !== 'string' || typeof checkOutIso !== 'string') {
			log.warn(
				{ tenantId, bookingId, checkInIso, checkOutIso },
				'migration_registration_enqueuer: missing checkIn/checkOut — skipping',
			)
			return
		}

		const config = await loadTenantConfig(tx, tenantId)
		if (!config) {
			log.warn(
				{ tenantId, bookingId },
				'migration_registration_enqueuer: tenant epgu config incomplete (МВД ОВМ onboarding pending?) — skipping',
			)
			return
		}

		const documentId = await findMostRecentDocument(tx, tenantId, primaryGuestId)
		if (!documentId) {
			log.warn(
				{ tenantId, bookingId, primaryGuestId },
				'migration_registration_enqueuer: no guestDocument for primaryGuestId — skipping (frontend invariant: scan passport before check-in)',
			)
			return
		}

		if (await migrationRegistrationExists(tx, tenantId, bookingId)) {
			log.debug(
				{ tenantId, bookingId },
				'migration_registration_enqueuer: registration already exists — idempotent skip',
			)
			return
		}

		const id = newId('migrationRegistration')
		const now = new Date()
		const nowTs = toTs(now)

		await tx`
			UPSERT INTO migrationRegistration (
				\`tenantId\`, \`id\`, \`bookingId\`, \`guestId\`, \`documentId\`,
				\`epguChannel\`, \`epguOrderId\`, \`epguApplicationNumber\`,
				\`serviceCode\`, \`targetCode\`, \`supplierGid\`, \`regionCode\`,
				\`arrivalDate\`, \`departureDate\`,
				\`statusCode\`, \`isFinal\`, \`reasonRefuse\`, \`errorCategory\`,
				\`submittedAt\`, \`lastPolledAt\`, \`nextPollAt\`, \`finalizedAt\`,
				\`retryCount\`, \`attemptsHistoryJson\`,
				\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
			) VALUES (
				${tenantId}, ${id}, ${bookingId}, ${primaryGuestId}, ${documentId},
				${config.epguDefaultChannel}, ${NULL_TEXT}, ${NULL_TEXT},
				${EPGU_SERVICE_CODE_MIGRATION_REGISTRATION},
				${EPGU_TARGET_CODE_MIGRATION_REGISTRATION},
				${config.epguSupplierGid}, ${config.epguRegionCodeFias},
				${dateFromIso(checkInIso)}, ${dateFromIso(checkOutIso)},
				${EPGU_STATUS_CODES.draft}, ${false}, ${NULL_TEXT}, ${NULL_TEXT},
				${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TIMESTAMP},
				${0}, ${toJson(null)},
				${nowTs}, ${nowTs}, ${ENQUEUER_ACTOR_ID}, ${ENQUEUER_ACTOR_ID}
			)
		`
		log.info(
			{ tenantId, bookingId, primaryGuestId, documentId, registrationId: id },
			'migration_registration_enqueuer: draft created on check-in',
		)
	}
}
