/**
 * Embed service — orchestrates bundle delivery + commit-token issuance for
 * the embed widget HTTP routes (M9.widget.6 / А4.3).
 *
 * Per `plans/m9_widget_6_canonical.md`:
 *   * D23 — path-segment hash URL `/embed/v1/:slug.:hash.js`. Backend reads
 *     bundle bytes at startup, computes SHA-384, exposes `currentHash` per
 *     bundle kind. Routes validate the URL `:hash` matches the current
 *     hash; mismatch → 410 Gone (forces tenant to fetch new embed snippet).
 *   * D10 — `<script integrity="sha384-{base64}">` consumers. We expose
 *     base64-of-SHA384 as `sriDigest` on the bundle metadata.
 *   * D25 — `clientCommitToken` sign + verify через жрбе jose 6.2.3 helpers.
 *
 * The service deliberately reads bundles ONCE at construction (synchronous
 * fs.readFileSync) — bundles are tiny (≤15 KB facade / ≤80 KB lazy) and
 * bound to the deploy artefact, не runtime-mutable. Routes serve these
 * bytes verbatim with per-tenant headers attached on the way out.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CommitTokenSecretSource } from '../../lib/embed/commit-token.ts'
import { signCommitToken, verifyCommitToken } from '../../lib/embed/commit-token.ts'
import type { createEmbedRepo } from './embed.repo.ts'

export type EmbedBundleKind = 'embed' | 'booking-flow'

export interface EmbedBundle {
	readonly kind: EmbedBundleKind
	readonly bytes: Buffer
	/** Hex SHA-384 (96 chars). URL path-segment + `widgetReleaseAudit.hash`. */
	readonly hashHex: string
	/** Base64 SHA-384 для `<script integrity="sha384-{this}">` SRI attribute. */
	readonly sriDigest: string
}

export interface EmbedServiceDeps {
	readonly repo: ReturnType<typeof createEmbedRepo>
	readonly secrets: CommitTokenSecretSource
	readonly bundlesDir: string
	/**
	 * Optional override для tests — caller can supply pre-loaded bundle
	 * bytes (avoids reading from real `apps/widget-embed/dist/`).
	 */
	readonly bundlesOverride?: Record<EmbedBundleKind, Buffer>
}

export type EmbedService = ReturnType<typeof createEmbedService>

const DEFAULT_BUNDLE_FILES: Record<EmbedBundleKind, string> = {
	embed: 'embed.js',
	'booking-flow': 'booking-flow.js',
}

/**
 * Build a bundle metadata record from raw bytes — single canonical SHA-384
 * computation captured both as hex (DB-friendly) AND base64 (SRI-friendly).
 */
function makeBundle(kind: EmbedBundleKind, bytes: Buffer): EmbedBundle {
	const sha384 = createHash('sha384').update(bytes).digest()
	return {
		kind,
		bytes,
		hashHex: sha384.toString('hex'),
		sriDigest: sha384.toString('base64'),
	}
}

/**
 * Constant-time equality на hex hash strings. Both arguments must be the
 * same length OR comparison returns false без leaking length info.
 *
 * Used для path-segment :hash validation per D23 — defends against forged
 * cache-busting URLs hitting the cached immutable response with attacker-
 * supplied hash.
 */
function timingSafeHexEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let mismatch = 0
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return mismatch === 0
}

export function createEmbedService(deps: EmbedServiceDeps) {
	const bundles: Record<EmbedBundleKind, EmbedBundle> = (() => {
		if (deps.bundlesOverride) {
			return {
				embed: makeBundle('embed', deps.bundlesOverride.embed),
				'booking-flow': makeBundle('booking-flow', deps.bundlesOverride['booking-flow']),
			}
		}
		const facade = readFileSync(path.join(deps.bundlesDir, DEFAULT_BUNDLE_FILES.embed))
		const flow = readFileSync(path.join(deps.bundlesDir, DEFAULT_BUNDLE_FILES['booking-flow']))
		return {
			embed: makeBundle('embed', facade),
			'booking-flow': makeBundle('booking-flow', flow),
		}
	})()

	return {
		/** Current bundle metadata for delivery routes. */
		getBundle(kind: EmbedBundleKind): EmbedBundle {
			return bundles[kind]
		},

		/**
		 * Validate the URL path-segment hash against the live bundle. Returns
		 * the bundle if the hash matches, null otherwise (route maps null to
		 * 410 Gone so tenant pages с stale snippet rebuild).
		 *
		 * Comparison is constant-time even though the inputs are public
		 * SRI hashes — defense-in-depth keeps the door closed if we later
		 * extend with secret-derived hashes.
		 */
		matchBundleByHash(kind: EmbedBundleKind, urlHash: string): EmbedBundle | null {
			const bundle = bundles[kind]
			return timingSafeHexEquals(bundle.hashHex, urlHash) ? bundle : null
		},

		/**
		 * Read tenant `publicEmbedDomains` allowlist для CORS reflection (D21).
		 * Returns the list of canonical https origins OR null when embedding
		 * is disabled / property private / cross-tenant.
		 */
		async getEmbedAllowlist(
			tenantId: string,
			propertyId: string,
		): Promise<readonly string[] | null> {
			return deps.repo.getPublicEmbedDomains(tenantId, propertyId)
		},

		async signCommitToken(input: { tenantId: string; slug: string }): Promise<string> {
			const nowSeconds = Math.floor(Date.now() / 1000)
			return signCommitToken(
				{ tenantId: input.tenantId, slug: input.slug, nowSeconds },
				deps.secrets,
			)
		},

		async verifyCommitToken(token: string) {
			return verifyCommitToken(token, deps.secrets)
		},

		/**
		 * Append a release-audit entry. Caller controls `id` (so kill-switch
		 * can pre-allocate `id` and pass it to the same `sql.begin()` tx as
		 * the source-of-truth UPDATE). Reason MUST be non-null on
		 * `action='revoked'` for forensic completeness.
		 */
		async recordReleaseEvent(input: {
			tenantId: string
			id: string
			hash: string
			bundleKind: EmbedBundleKind
			action: 'published' | 'revoked' | 'reauthorized'
			reason: string | null
			actorUserId: string
			actorSource: 'admin_ui' | 'cli' | 'ci' | 'cron'
			actionAt: Date
		}): Promise<void> {
			if (input.action === 'revoked' && (input.reason === null || input.reason.length === 0)) {
				throw new Error('embed.service: revoked action requires non-null reason')
			}
			await deps.repo.appendAudit(input)
		},

		/**
		 * Determine current authorisation status of the bundle hash by reading
		 * the latest audit row. Returns 'active' if the most recent action is
		 * 'published'/'reauthorized', 'revoked' if the most recent is
		 * 'revoked', 'unknown' если no audit record exists.
		 */
		async getReleaseStatus(
			tenantId: string,
			hash: string,
		): Promise<'active' | 'revoked' | 'unknown'> {
			const rows = await deps.repo.listAudit(tenantId, 100)
			const latestForHash = rows.find((r) => r.hash === hash)
			if (!latestForHash) return 'unknown'
			return latestForHash.action === 'revoked' ? 'revoked' : 'active'
		},
	}
}
