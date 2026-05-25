import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { getDemoInboxIfActive } from '../../workers/lib/postbox-adapter.ts'

/**
 * Demo-inbox public route — `GET /api/public/demo/inbox?email=…`.
 *
 * Mounted unconditionally в `app.ts` BUT gated by the `enabled` factory
 * option (read from `env.DEMO_DEPLOYMENT`). When disabled the handler
 * returns 404 для every request — belt-and-braces поверх the email-factory
 * env-gate so a production deployment cannot leak captures even if the
 * singleton is somehow initialized.
 *
 * **No authentication**: the demo deployment serves anonymous prospects
 * polling for their own self-typed email; there's no notion of «authorized»
 * here. Captures live in-process per recipient bucket — за rate-limiting и
 * RBL protection — bounded ring per `MAX_PER_RECIPIENT` + global LRU per
 * `MAX_TOTAL_RECIPIENTS` (see `demo-inbox-adapter.ts`).
 *
 * Response shape:
 *   200 + { data: { email, latestUrl, capturedAt, subject } } — capture found
 *   200 + { data: { email, latestUrl: null, capturedAt: null, subject: null } }
 *         — no fresh capture for this email yet (frontend keeps polling)
 *   400 — invalid email format (z.email() reject)
 *   404 — demo deployment disabled (production posture)
 *
 * Polling-based, не SSE. Reasons:
 *   - SSE adds long-lived connection state; demo prospect typically waits
 *     ~1-3 seconds for backend's BA `magicLink.send` callback to land —
 *     short-poll covers that без the SSE retry / reconnect rabbit hole.
 *   - Hono's SSE primitive is solid но adds a re-export surface to maintain.
 *     1Hz polling от frontend is negligible cost для the demo throughput
 *     envelope (one prospect at a time).
 */

const querySchema = z.object({
	email: z.email('invalid email format'),
	/**
	 * Round 7 v3 fix 2026-05-25 — race-free polling для smoke E2 return-visit.
	 * ISO-8601 timestamp; endpoint returns capture STRICTLY after this time.
	 * If absent → returns latest capture (backward-compatible).
	 * Pattern mirrors Mailosaur `received_after` + Mailhook `since`.
	 */
	since: z.iso.datetime({ offset: true }).optional(),
})

export interface DemoInboxResponse {
	readonly email: string
	readonly latestUrl: string | null
	readonly capturedAt: string | null
	readonly subject: string | null
}

export interface DemoInboxRoutesOptions {
	readonly enabled: boolean
}

export function createDemoInboxRoutes(opts: DemoInboxRoutesOptions) {
	return new Hono<AppEnv>().get('/inbox', zValidator('query', querySchema), (c) => {
		if (!opts.enabled) {
			return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
		}
		const { email, since } = c.req.valid('query')
		const inbox = getDemoInboxIfActive()
		if (!inbox) {
			// Demo deployment env was true at startup so adapter SHOULD exist,
			// но if the first email hasn't been dispatched yet the singleton
			// may still be uninitialized. Treat as «empty inbox».
			const response: DemoInboxResponse = {
				email,
				latestUrl: null,
				capturedAt: null,
				subject: null,
			}
			return c.json({ data: response }, 200)
		}
		const captured = inbox.getLatest(email, since ? new Date(since) : undefined)
		const response: DemoInboxResponse = captured
			? {
					email,
					latestUrl: captured.magicLinkUrl,
					capturedAt: captured.capturedAt.toISOString(),
					subject: captured.subject,
				}
			: {
					email,
					latestUrl: null,
					capturedAt: null,
					subject: null,
				}
		return c.json({ data: response }, 200)
	})
}
