/**
 * Round 13 — RFC 7591 DCR Hono routes.
 *
 * Mount: `/api/oauth/register`.
 */

import { Hono } from 'hono'
import type { AppEnv } from '../../factory.ts'
import { type DcrStore, validateClientMetadata } from './dcr.ts'

export function createDcrRoutes(store: DcrStore) {
	const app = new Hono<AppEnv>()

	app.post('/register', async (c) => {
		let body: unknown
		try {
			body = await c.req.json()
		} catch {
			return c.json(
				{ error: 'invalid_client_metadata', error_description: 'malformed JSON body' },
				400,
			)
		}
		const validated = validateClientMetadata(body)
		if (!validated.ok) {
			const err = validated.error
			if (err.kind === 'reserved_client_name') {
				return c.json(
					{
						error: 'invalid_client_metadata',
						error_description: 'client_name is reserved',
					},
					403,
				)
			}
			return c.json(
				{
					error:
						err.kind === 'invalid_redirect_uri'
							? 'invalid_redirect_uri'
							: 'invalid_client_metadata',
					error_description: err.detail,
				},
				400,
			)
		}
		const client = await store.register(validated.metadata)
		return c.json(client, 201)
	})

	return app
}
