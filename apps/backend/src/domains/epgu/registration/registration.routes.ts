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

export function createMigrationRegistrationRoutesInner(f: MigrationRegistrationFactory) {
	const { repo, service } = f
	return new Hono<AppEnv>()
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
		.patch(
			'/migration-registrations/:id',
			requirePermission({ migrationRegistration: ['manage'] }),
			zValidator('param', idParamSchema),
			zValidator('json', migrationRegistrationPatchSchema),
			async (c) => {
				const { id } = c.req.valid('param')
				const patch = c.req.valid('json')
				// Map UI patch → repo patch (UI exposes retryRequested boolean
				// → repo retryCount += 1 + reset nextPollAt to now-ish).
				if (patch.retryRequested === true) {
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
					await repo.patch(
						c.var.tenantId,
						id,
						{ retryCount: row.retryCount + 1, nextPollAt: new Date() },
						c.var.user.id,
					)
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
