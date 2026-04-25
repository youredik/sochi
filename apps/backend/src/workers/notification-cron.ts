/**
 * Cron-driven notification triggers (M7.B.3) — fires checkin_reminder
 * (24h before checkIn at 18:00 MSK) and review_request (24h after checkOut
 * at 11:00 MSK).
 *
 * Both jobs run hourly via croner ('0 * * * *', tz Europe/Moscow), filter
 * eligible bookings (status + date), and write notificationOutbox rows. The
 * existing dispatcher worker (M7.B.2) sends them through the email adapter.
 *
 * **Idempotency**: deterministic dedup key
 *   `booking:<bookingId>:checkin_reminder` / `:review_request` →
 *   UNIQUE on (tenantId, sourceEventDedupKey). Re-running the job in the
 *   same hour OR after a restart is a no-op.
 *
 * **Concurrency**: single-instance assumption. If we scale to N replicas,
 * elect leader via lease row keyed by `(jobName, businessHour)`.
 */

import { buildNotificationDedupKey, newId } from '@horeca/shared'
import { Cron } from 'croner'
import type { sql as SQL } from '../db/index.ts'
import { dateFromIso, NULL_TEXT, NULL_TIMESTAMP, toJson, toTs } from '../db/ydb-helpers.ts'
import {
	isCheckinReminderEligible,
	isInMskHour,
	isReviewRequestEligible,
	mskDateOffset,
} from './lib/notification-cron.ts'

type SqlInstance = typeof SQL

export interface NotificationCronLogger {
	debug: (obj: object, msg?: string) => void
	info: (obj: object, msg?: string) => void
	warn: (obj: object, msg?: string) => void
	error: (obj: object, msg?: string) => void
}

const NOTIFICATION_CRON_ACTOR_ID = 'system:notification_cron'
const CHECKIN_REMINDER_HOUR_MSK = 18
const REVIEW_REQUEST_HOUR_MSK = 11

export interface NotificationCronOptions {
	/** Cron expression (default '0 * * * *' — top of every hour). */
	schedule?: string
	/** Override checkin reminder hour (default 18 MSK). */
	checkinReminderHourMsk?: number
	/** Override review request hour (default 11 MSK). */
	reviewRequestHourMsk?: number
	/** Skip starting the cron (test mode — caller invokes runJobs directly). */
	skipTimer?: boolean
}

interface BookingRow {
	tenantId: string
	id: string
	status: string
	checkIn: Date
	checkOut: Date
	currency: string
}

export function startNotificationCron(
	sql: SqlInstance,
	log: NotificationCronLogger,
	opts: NotificationCronOptions = {},
): {
	stop: () => Promise<void>
	runJobs: (now?: Date) => Promise<{ checkinReminders: number; reviewRequests: number }>
} {
	const schedule = opts.schedule ?? '0 * * * *'
	const checkinHour = opts.checkinReminderHourMsk ?? CHECKIN_REMINDER_HOUR_MSK
	const reviewHour = opts.reviewRequestHourMsk ?? REVIEW_REQUEST_HOUR_MSK

	async function runJobs(now: Date = new Date()) {
		const stats = { checkinReminders: 0, reviewRequests: 0 }

		if (isInMskHour(now, checkinHour)) {
			stats.checkinReminders = await runCheckinReminders(sql, log, now)
		}
		if (isInMskHour(now, reviewHour)) {
			stats.reviewRequests = await runReviewRequests(sql, log, now)
		}

		if (stats.checkinReminders > 0 || stats.reviewRequests > 0) {
			log.info(
				{
					hour: now.toISOString(),
					checkinReminders: stats.checkinReminders,
					reviewRequests: stats.reviewRequests,
				},
				'notification-cron: job cycle complete',
			)
		}

		return stats
	}

	let job: Cron | null = null
	if (!opts.skipTimer) {
		job = new Cron(
			schedule,
			{
				timezone: 'Europe/Moscow',
				protect: true,
				catch: (err) => log.error({ err }, 'notification-cron: handler threw'),
			},
			async () => {
				await runJobs()
			},
		)
		log.info(
			{ schedule, checkinHour, reviewHour, nextRun: job.nextRun()?.toISOString() },
			'notification-cron: scheduled',
		)
	}

	return {
		stop: async () => {
			if (job) job.stop()
			log.info({}, 'notification-cron: stopped')
		},
		runJobs,
	}
}

/* ---------------------------------------------------------------- internals */

async function runCheckinReminders(
	sql: SqlInstance,
	log: NotificationCronLogger,
	now: Date,
): Promise<number> {
	const tomorrow = mskDateOffset(now, 1)
	// Pull bookings whose checkIn = tomorrow regardless of status; pure-lib
	// `isCheckinReminderEligible` will filter status=confirmed/in_house.
	const bookings = await loadBookingsByCheckIn(sql, tomorrow)
	let written = 0
	for (const booking of bookings) {
		const checkInIso = toIsoDate(booking.checkIn)
		if (!isCheckinReminderEligible({ status: booking.status, checkIn: checkInIso }, tomorrow)) {
			continue
		}
		const ok = await tryInsertOutboxRow(sql, log, booking, 'checkin_reminder', now)
		if (ok) written += 1
	}
	return written
}

async function runReviewRequests(
	sql: SqlInstance,
	log: NotificationCronLogger,
	now: Date,
): Promise<number> {
	const yesterday = mskDateOffset(now, -1)
	const bookings = await loadBookingsByCheckOut(sql, yesterday)
	let written = 0
	for (const booking of bookings) {
		const checkOutIso = toIsoDate(booking.checkOut)
		if (!isReviewRequestEligible({ status: booking.status, checkOut: checkOutIso }, yesterday)) {
			continue
		}
		const ok = await tryInsertOutboxRow(sql, log, booking, 'review_request', now)
		if (ok) written += 1
	}
	return written
}

async function loadBookingsByCheckIn(sql: SqlInstance, checkInIso: string): Promise<BookingRow[]> {
	const [rows = []] = await sql<BookingRow[]>`
		SELECT tenantId, id, status, checkIn, checkOut, currency
		FROM booking
		WHERE checkIn = ${dateFromIso(checkInIso)}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows
}

async function loadBookingsByCheckOut(
	sql: SqlInstance,
	checkOutIso: string,
): Promise<BookingRow[]> {
	// No index on checkOut; scan + post-filter. SMB scale (<10k bookings) — fine.
	// If we ever scale we'll add `INDEX ixBookingCheckOut GLOBAL SYNC ON (tenantId, checkOut)`.
	const [rows = []] = await sql<BookingRow[]>`
		SELECT tenantId, id, status, checkIn, checkOut, currency
		FROM booking
		WHERE checkOut = ${dateFromIso(checkOutIso)}
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	return rows
}

async function tryInsertOutboxRow(
	sql: SqlInstance,
	log: NotificationCronLogger,
	booking: BookingRow,
	kind: 'checkin_reminder' | 'review_request',
	now: Date,
): Promise<boolean> {
	const dedupKey = buildNotificationDedupKey({
		sourceObjectType: 'booking',
		sourceObjectId: booking.id,
		kind,
	})

	// Pre-check: dedup row may exist from prior cron firing or replay.
	const [existing = []] = await sql<{ x: number }[]>`
		SELECT 1 AS x FROM notificationOutbox VIEW ixNotificationDedup
		WHERE tenantId = ${booking.tenantId} AND sourceEventDedupKey = ${dedupKey}
		LIMIT 1
	`
		.isolation('snapshotReadOnly')
		.idempotent(true)
	if (existing.length > 0) {
		log.debug(
			{ tenantId: booking.tenantId, bookingId: booking.id, kind, dedupKey },
			'notification-cron: dedup row already exists — skip',
		)
		return false
	}

	const subject = kind === 'checkin_reminder' ? 'Напоминание о заезде' : 'Поделитесь впечатлениями'
	const id = newId('notification')
	const nowTs = toTs(now)
	const payload = {
		bookingId: booking.id,
		checkIn: toIsoDate(booking.checkIn),
		checkOut: toIsoDate(booking.checkOut),
		currency: booking.currency,
	}

	await sql`
		UPSERT INTO notificationOutbox (
			\`tenantId\`, \`id\`,
			\`kind\`, \`channel\`, \`recipient\`, \`subject\`, \`bodyText\`, \`payloadJson\`,
			\`status\`,
			\`sentAt\`, \`failedAt\`, \`failureReason\`, \`retryCount\`,
			\`sourceObjectType\`, \`sourceObjectId\`, \`sourceEventDedupKey\`,
			\`createdAt\`, \`updatedAt\`, \`createdBy\`, \`updatedBy\`
		) VALUES (
			${booking.tenantId}, ${id},
			${kind}, ${'email'}, ${'guest@placeholder.local'}, ${subject}, ${NULL_TEXT}, ${toJson(payload)},
			${'pending'},
			${NULL_TIMESTAMP}, ${NULL_TIMESTAMP}, ${NULL_TEXT}, ${0},
			${'booking'}, ${booking.id}, ${dedupKey},
			${nowTs}, ${nowTs}, ${NOTIFICATION_CRON_ACTOR_ID}, ${NOTIFICATION_CRON_ACTOR_ID}
		)
	`
	log.info(
		{ tenantId: booking.tenantId, bookingId: booking.id, kind, dedupKey },
		'notification-cron: outbox row created',
	)
	return true
}

function toIsoDate(d: Date): string {
	return d.toISOString().slice(0, 10)
}
