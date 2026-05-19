/**
 * Demo SMS inbox public route — `GET /api/public/demo/sms-inbox?phone=…`.
 *
 * Symmetric к email demo inbox route (existing canon). Mounted unconditionally
 * в `app.ts` BUT gated by `enabled` factory option (read from
 * `env.DEMO_DEPLOYMENT`). When disabled — 404 for every request.
 *
 * **No authentication**: anonymous prospect polls for their own self-typed
 * phone; captures live in-process per recipient bucket (DemoInboxSmsAdapter
 * MAX_PER_RECIPIENT + MAX_TOTAL_RECIPIENTS bounds).
 *
 * **Polling, не SSE** — matches email inbox canon (1Hz polling cheap для
 * demo throughput envelope).
 *
 * Response shape:
 *   200 + { data: { phone, body, capturedAt } } — capture found
 *   200 + { data: { phone, body: null, capturedAt: null } } — no fresh capture
 *   400 — invalid phone format (E.164 reject)
 *   404 — demo deployment disabled (production posture)
 */

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../factory.ts'
import { getDemoInboxSmsIfActive } from '../../workers/lib/demo-inbox-sms-adapter.ts'
import { normalizePhoneE164 } from '../../workers/lib/sms-adapter.types.ts'

const querySchema = z.object({
	phone: z
		.string()
		.min(8, 'phone too short')
		.max(20, 'phone too long')
		.refine((v) => normalizePhoneE164(v) !== null, {
			message: 'phone must be valid E.164 format (e.g. +79991234567)',
		}),
})

export interface DemoSmsInboxResponse {
	readonly phone: string
	readonly body: string | null
	readonly capturedAt: string | null
}

export interface DemoSmsInboxRoutesOptions {
	readonly enabled: boolean
}

export function createDemoSmsInboxRoutes(opts: DemoSmsInboxRoutesOptions) {
	return new Hono<AppEnv>().get('/sms-inbox', zValidator('query', querySchema), (c) => {
		if (!opts.enabled) {
			return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
		}
		const { phone } = c.req.valid('query')
		// Already validated via Zod refine; normalize again к get canonical form.
		const normalized = normalizePhoneE164(phone)
		if (normalized === null) {
			// Defensive — Zod already rejected; here only if refine bypassed.
			return c.json({ error: { code: 'INVALID_PHONE', message: 'phone must be valid E.164' } }, 400)
		}
		const inbox = getDemoInboxSmsIfActive()
		if (!inbox) {
			const response: DemoSmsInboxResponse = {
				phone: normalized,
				body: null,
				capturedAt: null,
			}
			return c.json({ data: response }, 200)
		}
		const captured = inbox.getLatest(normalized)
		const response: DemoSmsInboxResponse = captured
			? {
					phone: normalized,
					body: captured.body,
					capturedAt: captured.capturedAt.toISOString(),
				}
			: {
					phone: normalized,
					body: null,
					capturedAt: null,
				}
		return c.json({ data: response }, 200)
	})
}
