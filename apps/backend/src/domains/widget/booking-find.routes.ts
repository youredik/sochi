/**
 * Public widget booking-find routes (M9.widget.5 / A3.1.c — Track A3).
 *
 * POST /api/public/widget/:tenantSlug/booking/find
 *   Body: { reference: string, email: string }
 *   Always 200 OK + unified body — timing-safe per `plans/m9_widget_5_canonical.md`
 *   §D6 (NEVER 404 wrong-ref vs 403 wrong-email — leaks user enumeration).
 *
 *   Promise.allSettled + Math.max(0, FIXED-elapsed) padding canon (Cloudflare
 *   Workers + Laravel timeboxing) — fixed 800ms total response time prevents
 *   YDB latency variance from leaking «ref exists» signal.
 *
 *   Rate-limit two-tier (D7):
 *     1. Burst+steady IP+slug per `widget-rate-limit.ts` (existing canon)
 *     2. Tuple-key (emailNormalized, reference) post-validation —
 *        5 req/15min — protects mobile NAT users (МТС/Билайн ~1k subs/IP)
 *        from being false-positive blocked
 *
 * On match (booking exists + guest email matches):
 *   - Issue view-scope JWT (24h TTL, attemptsRemaining=5 для Apple MPP buffer)
 *   - Write notificationOutbox row (kind='booking_magic_link') с pre-rendered
 *     subject + bodyText. Existing dispatcher CDC consumer picks up + sends.
 *
 * On no-match:
 *   - Same 200 OK response shape, same delay padding — NO email sent
 *   - Rate-limit still consumes a tuple slot (defense-in-depth)
 */

import { zValidator } from '@hono/zod-validator'
import { newId } from '@horeca/shared'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { z } from 'zod'
import { env } from '../../env.ts'
import type { AppEnv } from '../../factory.ts'
import {
	widgetBurstRateLimiter,
	widgetSteadyRateLimiter,
} from '../../middleware/widget-rate-limit.ts'
import { widgetTenantResolverMiddleware } from '../../middleware/widget-tenant-resolver.ts'
import { renderTemplate } from '../../workers/lib/notification-templates.ts'
import type { BookingFindRepo } from './booking-find.repo.ts'
import type { MagicLinkService } from './magic-link.service.ts'

/** Fixed total response time для timing-safe canon (per plan §D6). */
const FIXED_RESPONSE_MS = 800

/** Tuple-key rate-limit: 5 req per (email, ref) per 15 min. */
const TUPLE_KEY_LIMIT = 5
const TUPLE_KEY_WINDOW_MS = 15 * 60 * 1000

const bookingFindRequestSchema = z.object({
	reference: z.string().min(1).max(64).trim(),
	email: z.string().min(3).max(254).trim().toLowerCase(),
})

const UNIFIED_RESPONSE_BODY = {
	ok: true as const,
	message: 'Если бронирование найдено, ссылка для управления отправлена на указанный email.',
}

/** Stable concatenated key для in-memory tuple-key rate-limit map. */
function makeTupleKey(emailLower: string, reference: string): string {
	return `${emailLower}::${reference}`
}

/**
 * In-memory tuple-key rate-limit store. Single-instance YC Serverless Container
 * canon Phase 1 (per `plans/m9_widget_5_canonical.md` §D7); multi-instance
 * carry-forward к YDB-backed store M10+.
 */
class TupleKeyStore {
	private readonly counts = new Map<string, { count: number; resetAt: number }>()

	check(key: string, now: number): { allowed: boolean; remaining: number; resetAt: number } {
		const entry = this.counts.get(key)
		if (!entry || entry.resetAt <= now) {
			const resetAt = now + TUPLE_KEY_WINDOW_MS
			this.counts.set(key, { count: 1, resetAt })
			return { allowed: true, remaining: TUPLE_KEY_LIMIT - 1, resetAt }
		}
		if (entry.count >= TUPLE_KEY_LIMIT) {
			return { allowed: false, remaining: 0, resetAt: entry.resetAt }
		}
		entry.count++
		return { allowed: true, remaining: TUPLE_KEY_LIMIT - entry.count, resetAt: entry.resetAt }
	}

	/** Test-only — reset all counters. */
	reset(): void {
		this.counts.clear()
	}
}

interface IssueAndDispatchInput {
	readonly tenantId: string
	readonly bookingId: string
	readonly propertyName: string
	readonly guestEmail: string
	readonly senderOrgName: string
	readonly senderInn: string
}

/**
 * Issue view-scope magic-link JWT + write notificationOutbox row с pre-rendered
 * email body. Idempotent: multiple find calls на same booking issue fresh JWTs
 * (each gets unique jti) but each generates its own outbox row (no collision —
 * sourceEventDedupKey includes notification.id).
 */
async function issueAndDispatch(
	magicLinkService: MagicLinkService,
	repo: BookingFindRepo,
	input: IssueAndDispatchInput,
	clientIp: string,
): Promise<void> {
	const { jwt } = await magicLinkService.issue({
		tenantId: input.tenantId,
		bookingId: input.bookingId,
		scope: 'view',
		issuedFromIp: clientIp,
	})

	const magicLinkUrl = `${env.PUBLIC_BASE_URL}/booking/jwt/${jwt}`
	const rendered = renderTemplate('booking_magic_link', {
		guestName: 'гость',
		propertyName: input.propertyName,
		bookingReference: input.bookingId,
		magicLinkUrl,
		senderOrgName: input.senderOrgName,
		senderInn: input.senderInn,
		senderEmail: env.EMAIL_FROM_ADDRESS,
	})

	const notificationId = newId('notification')
	const now = new Date()
	const dedupKey = `booking:${input.bookingId}:booking_magic_link:${notificationId}`
	const payloadJson = JSON.stringify({
		source: 'booking',
		sourceObjectId: input.bookingId,
		magicLinkUrl,
	})

	await repo.insertMagicLinkOutbox({
		tenantId: input.tenantId,
		notificationId,
		bookingId: input.bookingId,
		recipientEmail: input.guestEmail,
		subject: rendered.subject,
		bodyText: rendered.text,
		payloadJson,
		dedupKey,
		now,
	})
}

interface BookingFindRoutesDeps {
	readonly magicLinkService: MagicLinkService
	readonly repo: BookingFindRepo
	readonly burstRateLimiter?: typeof widgetBurstRateLimiter
	readonly steadyRateLimiter?: typeof widgetSteadyRateLimiter
	/** Test override — fixed delay (default FIXED_RESPONSE_MS=800). */
	readonly fixedResponseMs?: number
	/** Test override — pre-built tuple-key store (для shared state across requests). */
	readonly tupleStore?: TupleKeyStore
}

export function createBookingFindRoutes(deps: BookingFindRoutesDeps) {
	const burst = deps.burstRateLimiter ?? widgetBurstRateLimiter
	const steady = deps.steadyRateLimiter ?? widgetSteadyRateLimiter
	const fixedMs = deps.fixedResponseMs ?? FIXED_RESPONSE_MS
	const tupleStore = deps.tupleStore ?? new TupleKeyStore()

	return new Hono<AppEnv>()
		.use(
			'/:tenantSlug/booking/find',
			cors({
				origin: '*',
				allowMethods: ['POST', 'OPTIONS'],
				allowHeaders: ['Content-Type', 'x-request-id', 'traceparent', 'tracestate'],
				maxAge: 86400,
			}),
		)
		.use('/:tenantSlug/booking/find', burst)
		.use('/:tenantSlug/booking/find', steady)
		.use('/:tenantSlug/booking/find', widgetTenantResolverMiddleware())
		.post('/:tenantSlug/booking/find', zValidator('json', bookingFindRequestSchema), async (c) => {
			const input = c.req.valid('json')
			const tenantId = c.var.tenantId
			const clientIp =
				c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
				c.req.header('x-real-ip') ??
				'anonymous'
			const tupleKey = makeTupleKey(input.email, input.reference)
			const tupleResult = tupleStore.check(tupleKey, Date.now())

			const t0 = Date.now()
			const flow = async (): Promise<void> => {
				if (!tupleResult.allowed) return // silent drop — same response shape
				const matched = await deps.repo.lookupBookingByReferenceAndEmail(
					tenantId,
					input.reference,
					input.email,
				)
				if (!matched) return
				await issueAndDispatch(
					deps.magicLinkService,
					deps.repo,
					{
						tenantId,
						bookingId: matched.bookingId,
						propertyName: matched.propertyName,
						guestEmail: matched.guestEmail,
						senderOrgName: matched.senderOrgName,
						senderInn: matched.senderInn,
					},
					clientIp,
				)
			}
			// Promise.allSettled + Math.max padding canon (Cloudflare Workers
			// + Laravel timeboxing). Fixed total response time prevents YDB
			// query-latency variance from leaking «ref exists» signal.
			await Promise.allSettled([flow(), new Promise((r) => setTimeout(r, fixedMs))])
			const elapsed = Date.now() - t0
			const remaining = Math.max(0, fixedMs - elapsed)
			if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))

			c.header('Cache-Control', 'no-store')
			return c.json(UNIFIED_RESPONSE_BODY, 200)
		})
}

export { TupleKeyStore }
export const __testInternals = {
	makeTupleKey,
	TUPLE_KEY_LIMIT,
	TUPLE_KEY_WINDOW_MS,
	FIXED_RESPONSE_MS,
}
