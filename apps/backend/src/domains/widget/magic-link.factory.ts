/**
 * MagicLinkService factory (M9.widget.5 / A3.1.b).
 *
 * Composes per-tenant secret resolver + atomic-consume token repo into the
 * service. Constructed once at app boot from `sql` instance and consumed
 * by routes (booking-find / magic-link-consume / guest-portal).
 *
 * Pattern matches existing widget factories (`widget.factory.ts`,
 * `booking-create.factory.ts`).
 */

import type { sql as SQL } from '../../db/index.ts'
import { createMagicLinkSecretResolver } from '../../lib/magic-link/secret.ts'
import { createMagicLinkTokenRepo } from './magic-link.repo.ts'
import { createMagicLinkService, type MagicLinkService } from './magic-link.service.ts'

type SqlInstance = typeof SQL

export function createMagicLinkFactory(sql: SqlInstance): { service: MagicLinkService } {
	const service = createMagicLinkService({
		secretResolver: createMagicLinkSecretResolver(sql),
		tokenRepo: createMagicLinkTokenRepo(sql),
	})
	return { service }
}
