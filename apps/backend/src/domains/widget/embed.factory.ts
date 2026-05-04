/**
 * Embed factory — wires `embed.repo` + secret resolver + bundles into the
 * shared `embed.service` instance consumed by `embed.routes.ts`.
 *
 * Per `plans/m9_widget_6_canonical.md` §A4.3:
 *   * Bundles live в `apps/widget-embed/dist/` after `pnpm build` (CI mirrors
 *     to Yandex Object Storage; backend reads local copy at startup so Hono
 *     can attach per-tenant headers — Yandex Object Storage не supports
 *     per-tenant header injection per docs 2026-05).
 *   * `commitTokenSecrets` resolved from env (`COMMIT_TOKEN_HMAC_CURRENT` +
 *     `COMMIT_TOKEN_HMAC_PREVIOUS`); production deploys seed both from
 *     Yandex Lockbox (D25 sliding-window rotation canon).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { sql as SQL } from '../../db/index.ts'
import type { CommitTokenSecretSource } from '../../lib/embed/commit-token.ts'
import { createEmbedRepo } from './embed.repo.ts'
import { createEmbedService } from './embed.service.ts'

type SqlInstance = typeof SQL

export interface EmbedFactoryOptions {
	readonly sql: SqlInstance
	readonly currentSecretBase64: string
	readonly previousSecretBase64?: string | undefined
	/**
	 * Optional override of bundles directory — defaults to `apps/widget-embed/dist/`
	 * resolved relative to the running backend process. Tests pass a temp dir.
	 */
	readonly bundlesDir?: string
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Default bundles directory. `apps/backend/src/domains/widget/embed.factory.ts`
 * resolves to `apps/widget-embed/dist/` via 4-level traversal.
 */
const DEFAULT_BUNDLES_DIR = path.resolve(__dirname, '../../../../widget-embed/dist')

function decodeSecret(value: string, label: string): Uint8Array {
	const buf = Buffer.from(value, 'utf-8')
	if (buf.byteLength < 32) {
		throw new Error(`embed.factory: ${label} must be ≥32 bytes`)
	}
	return new Uint8Array(buf)
}

export function createEmbedFactory(opts: EmbedFactoryOptions) {
	const repo = createEmbedRepo(opts.sql)
	const secrets: CommitTokenSecretSource = {
		current: decodeSecret(opts.currentSecretBase64, 'COMMIT_TOKEN_HMAC_CURRENT'),
		previous: opts.previousSecretBase64
			? decodeSecret(opts.previousSecretBase64, 'COMMIT_TOKEN_HMAC_PREVIOUS')
			: null,
	}
	const service = createEmbedService({
		repo,
		secrets,
		bundlesDir: opts.bundlesDir ?? DEFAULT_BUNDLES_DIR,
	})
	return { repo, service }
}
