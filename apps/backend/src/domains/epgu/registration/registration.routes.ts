/**
 * Migration registration HTTP routes — operator API + manual triggers.
 *
 * Closes (per project_initial_framing.md mandate):
 *   - 1.1 Госуслуги (Скала-ЕПГУ) — operator UI surface for status review,
 *     manual retry, manual cancel
 *
 * Endpoints (under /api/v1):
 *   GET    /bookings/:bookingId/migration-registrations — list per booking
 *   GET    /migration-registrations/:id                  — single
 *   POST   /migration-registrations/:id/submit          — manual phase 1+2
 *   POST   /migration-registrations/:id/poll            — manual poll
 *   PATCH  /migration-registrations/:id                  — operator note / retry trigger
 *
 * RBAC:
 *   * read    — owner + manager + staff (front-desk visibility)
 *   * manage  — owner + manager (retry/cancel = legal action)
 *   * create  — auto via CDC consumer (M8.A.5.cdc); UI POST в M8.A.6
 *
 * Stable response envelope `{ data: ... }`. Errors via global onError.
 */

import { zValidator } from '@hono/zod-validator'
import { type EpguChannel, migrationRegistrationPatchSchema } from '@horeca/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../../factory.ts'
import { authMiddleware } from '../../../middleware/auth.ts'
import type { IdempotencyMiddleware } from '../../../middleware/idempotency.ts'
import { requirePermission } from '../../../middleware/require-permission.ts'
import { tenantMiddleware } from '../../../middleware/tenant.ts'
import type { MigrationRegistrationFactory } from './registration.factory.ts'

const idParamSchema = z.object({ id: z.string().min(1).max(100) })
const bookingIdParamSchema = z.object({ bookingId: z.string().min(1).max(100) })

/** Submit body — archive bytes (base64) + channel override (rare; per-tenant default). */
const submitBodySchema = z.object({
	archiveBase64: z.string().min(1),
	channel: z.enum(['gost-tls', 'svoks', 'proxy-via-partner']).optional(),
})

/**
 * Cancel body — operator must provide reason text для audit trail.
 * Min 5 chars (защита от пустых/случайных), max 500 (UI-side limit).
 */
const cancelBodySchema = z.object({
	reason: z.string().min(5).max(500),
})

export function createMigrationRegistrationRoutesInner(f: MigrationRegistrationFactory) {
	const { repo, service } = f
	return new Hono<AppEnv>()
		.get(
			'/migration-registrations',
			requirePermission({ migrationRegistration: ['read'] }),
			zValidator(
				'query',
				z.object({
					limit: z
						.string()
						.regex(/^\d+$/)
						.transform((v) => Number(v))
						.optional(),
				}),
			),
			async (c) => {
				const { limit } = c.req.valid('query')
				const data = await repo.listForTenant(c.var.tenantId, limit ?? 100)
				return c.json({ data }, 200)
			},
		)
		.get(
			'/bookings/:bookingId/migration-registrations',
			zValidator('param', bookingIdParamSchema),
			requirePermission({ migrationRegistration: ['read'] }),
			async (c) => {
				const { bookingId } = c.req.valid('param')
				const data = await repo.listByBooking(c.var.tenantId, bookingId)
				return c.json({ data }, 200)
			},
		)
		.get(
			'/migration-registrations/:id',
			zValidator('param', idParamSchema),
			requirePermission({ migrationRegistration: ['read'] }),
			async (c) => {
				const { id } = c.req.valid('param')
				const data = await repo.getById(c.var.tenantId, id)
				if (!data) {
					return c.json(
						{
							error: {
								code: 'NOT_FOUND',
								message: `Migration registration '${id}' not found`,
							},
						},
						404,
					)
				}
				return c.json({ data }, 200)
			},
		)
		.post(
			'/migration-registrations/:id/submit',
			requirePermission({ migrationRegistration: ['manage'] }),
			zValidator('param', idParamSchema),
			zValidator('json', submitBodySchema),
			async (c) => {
				const { id } = c.req.valid('param')
				const body = c.req.valid('json')
				// archive = base64 → Uint8Array. Real archive built by
				// M8.A.5.archive (XML+SIG); этот endpoint accepts pre-built
				// для UI flexibility / debug submit.
				const archive = Uint8Array.from(Buffer.from(body.archiveBase64, 'base64'))
				if (archive.length === 0) {
					return c.json(
						{
							error: { code: 'BAD_REQUEST', message: 'archiveBase64 декодируется в пустой массив' },
						},
						400,
					)
				}
				const result = await service.submit(c.var.tenantId, id, archive)
				return c.json({ data: result }, 200)
			},
		)
		.post(
			'/migration-registrations/:id/poll',
			requirePermission({ migrationRegistration: ['manage'] }),
			zValidator('param', idParamSchema),
			async (c) => {
				const { id } = c.req.valid('param')
				const result = await service.pollOne(c.var.tenantId, id)
				const data = await repo.getById(c.var.tenantId, id)
				if (!data) {
					return c.json(
						{ error: { code: 'NOT_FOUND', message: `Migration registration '${id}' not found` } },
						404,
					)
				}
				return c.json({ data: { ...data, polled: result } }, 200)
			},
		)
		.post(
			'/migration-registrations/:id/cancel',
			requirePermission({ migrationRegistration: ['manage'] }),
			zValidator('param', idParamSchema),
			zValidator('json', cancelBodySchema),
			async (c) => {
				const { id } = c.req.valid('param')
				const { reason } = c.req.valid('json')
				try {
					const result = await service.cancel(c.var.tenantId, id, reason)
					const data = await repo.getById(c.var.tenantId, id)
					if (!data) {
						return c.json(
							{
								error: {
									code: 'NOT_FOUND',
									message: `Migration registration '${id}' not found`,
								},
							},
							404,
						)
					}
					return c.json({ data: { ...data, cancel: result } }, 200)
				} catch (err) {
					const msg = err instanceof Error ? err.message : 'cancel failed'
					if (msg.includes('not found')) {
						return c.json({ error: { code: 'NOT_FOUND', message: msg } }, 404)
					}
					if (msg.includes('not yet submitted') || msg.includes('already in final')) {
						return c.json({ error: { code: 'CONFLICT', message: msg } }, 409)
					}
					throw err
				}
			},
		)
		.patch(
			'/migration-registrations/:id',
			requirePermission({ migrationRegistration: ['manage'] }),
			zValidator('param', idParamSchema),
			zValidator('json', migrationRegistrationPatchSchema),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				// Map UI patch → repo patch:
				//   - retryRequested=true → retryCount += 1 + reset nextPollAt to now
				//   - operatorNote (string|null|undefined): three-state passthrough
				const row = await repo.getById(c.var.tenantId, id)
				if (!row) {
					return c.json(
						{
							error: {
								code: 'NOT_FOUND',
								message: `Migration registration '${id}' not found`,
							},
						},
						404,
					)
				}
				const repoPatch: {
					retryCount?: number
					nextPollAt?: Date | null
					operatorNote?: string | null
				} = {}
				if (patch.retryRequested === true) {
					repoPatch.retryCount = row.retryCount + 1
					repoPatch.nextPollAt = new Date()
				}
				if (patch.operatorNote !== undefined) {
					repoPatch.operatorNote = patch.operatorNote
				}
				if (Object.keys(repoPatch).length > 0) {
					await repo.patch(c.var.tenantId, id, repoPatch, c.var.user.id)
				}
				const result = await repo.getById(c.var.tenantId, id)
				if (!result) {
					return c.json(
						{
							error: {
								code: 'NOT_FOUND',
								message: `Migration registration '${id}' not found`,
							},
						},
						404,
					)
				}
				return c.json({ data: result }, 200)
			},
		)
}

/** Production wrapper — auth + tenant + idempotency middleware chain. */
export function createMigrationRegistrationRoutes(
	f: MigrationRegistrationFactory,
	idempotency: IdempotencyMiddleware,
) {
	return new Hono<AppEnv>()
		.use('*', authMiddleware(), tenantMiddleware())
		.use('*', idempotency)
		.route('/', createMigrationRegistrationRoutesInner(f))
}

// Types not used outside this module — keep narrow surface.
export type { EpguChannel }
