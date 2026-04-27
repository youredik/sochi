/**
 * Property media service. Orchestrates the upload → process → finalize
 * lifecycle on top of the repo + storage adapter.
 *
 * Plan v2 §7.1 #1 — closes M8.A.0.4 by replacing the StubMediaStorage's
 * "flag-only" markDerivedReady with the real sharp pipeline:
 *
 *     uploadAndProcess(deps, input)
 *        ├── repo.create(...)                  ← first, persist metadata
 *        ├── storage.simulateUpload(key, bytes) ← STUB only; prod uses
 *        │                                       browser-side PUT
 *        ├── processMediaUpload(...)            ← sharp: 11 derived files
 *        ├── for each derived: storage.putDerivedBytes
 *        ├── storage.markDerivedReady(originalKey)
 *        └── repo.markProcessed(...)            ← flip exifStripped +
 *                                                 derivedReady on the row
 *
 * Hero invariant (`checkHeroAltText`) is enforced HERE — service layer is
 * the right boundary for cross-field invariants that span schema + business
 * rules. The repo deliberately allows multiple heroes and missing alt text
 * because partial state is normal during a wizard.
 */

import {
	buildMediaOriginalKey,
	checkHeroAltText,
	type MediaKind,
	type MediaMimeType,
	type PropertyMedia,
	type PropertyMediaCreateInput,
} from '@horeca/shared'
import type { createMediaRepo } from './media.repo.ts'
import { processMediaUpload } from './media-processor.ts'
import type { MediaStorage } from './media-storage.ts'

export interface MediaServiceDeps {
	readonly repo: ReturnType<typeof createMediaRepo>
	readonly storage: MediaStorage
}

export interface UploadAndProcessInput {
	readonly tenantId: string
	readonly propertyId: string
	readonly mediaId: string
	readonly actorId: string
	/** Operator-provided metadata (validated via Zod at route boundary). */
	readonly meta: PropertyMediaCreateInput
	/** Bytes the operator just uploaded (or, in tests, fixture bytes). */
	readonly originalBytes: Buffer
}

export interface UploadAndProcessResult {
	readonly media: PropertyMedia
	readonly variantCount: number
	readonly derivedKeys: readonly string[]
}

/**
 * **Test-only convenience** — runs `repo.create` + `storage.simulateUpload`
 * + `finalizeUploaded` in one call. NOT used by HTTP routes.
 *
 * The production flow is split across two endpoints:
 *   1. `POST /media`                     — operator metadata + create row
 *      (browser uploads bytes via separate PUT to Object Storage)
 *   2. `POST /media/:id/process`         — finalize: read bytes from
 *      storage, run sharp, upload variants, flip flags
 *
 * This helper exists so service-level tests + dev tooling can exercise
 * the full pipeline in one synchronous call without standing up a real
 * pre-signed PUT round-trip. Marked `@internal` — do NOT call from
 * production code.
 *
 * Throws (and does NOT mark as processed) if:
 *   - bytes exceed `meta.fileSizeBytes` (caller miscount)
 *   - sharp can't decode the source
 *
 * @internal
 */
export async function uploadAndProcess(
	deps: MediaServiceDeps,
	input: UploadAndProcessInput,
): Promise<UploadAndProcessResult> {
	if (BigInt(input.originalBytes.length) > input.meta.fileSizeBytes) {
		throw new Error(
			`uploadAndProcess: bytes length (${input.originalBytes.length}) exceeds declared fileSizeBytes (${input.meta.fileSizeBytes})`,
		)
	}

	// Persist metadata first — operator can see "uploading" state in UI.
	const created = await deps.repo.create(
		input.tenantId,
		input.propertyId,
		input.mediaId,
		input.meta,
		input.actorId,
	)

	// Stub-only short-circuit: register pre-signed PUT and seed bytes
	// synchronously so subsequent reads work. Prod skips this (browser PUT
	// landed bytes already).
	if (deps.storage.simulateUpload) {
		await deps.storage.getPresignedPut({
			key: input.meta.originalKey,
			contentType: input.meta.mimeType,
			maxBytes: Number(input.meta.fileSizeBytes),
		})
		deps.storage.simulateUpload(input.meta.originalKey, input.originalBytes)
	}

	return finalizeUploaded(deps, {
		tenantId: input.tenantId,
		propertyId: input.propertyId,
		mediaId: input.mediaId,
		actorId: input.actorId,
		originalKey: input.meta.originalKey,
		mimeType: input.meta.mimeType,
		_known: created,
	})
}

/**
 * Finalize an upload that has ALREADY landed in storage (real prod path
 * after browser PUT + webhook). Reads bytes back from storage, runs sharp,
 * uploads variants, flips the flags.
 */
export async function finalizeUploaded(
	deps: MediaServiceDeps,
	input: {
		readonly tenantId: string
		readonly propertyId: string
		readonly mediaId: string
		readonly actorId: string
		readonly originalKey: string
		readonly mimeType: MediaMimeType
		/** Internal optimization: skip a re-fetch when caller just created the row. */
		readonly _known?: PropertyMedia
	},
): Promise<UploadAndProcessResult> {
	const bytes = await deps.storage.getOriginalBytes(input.originalKey)
	if (bytes === null) {
		throw new Error(`finalizeUploaded: no original bytes for key '${input.originalKey}'`)
	}
	const result = await processMediaUpload({
		tenantId: input.tenantId,
		propertyId: input.propertyId,
		mediaId: input.mediaId,
		originalBytes: bytes,
		sourceMimeType: input.mimeType,
	})
	for (const v of result.variants) {
		await deps.storage.putDerivedBytes(v.key, v.bytes)
	}
	await deps.storage.markDerivedReady(input.originalKey)
	const ok = await deps.repo.markProcessed(
		input.tenantId,
		input.propertyId,
		input.mediaId,
		input.actorId,
	)
	if (!ok) {
		throw new Error(
			`finalizeUploaded: media row ${input.mediaId} not found at flip-flags time (race?)`,
		)
	}
	const media =
		input._known ?? (await deps.repo.getById(input.tenantId, input.propertyId, input.mediaId))
	if (!media) {
		throw new Error(`finalizeUploaded: media row ${input.mediaId} disappeared`)
	}
	// Re-read so caller sees the post-process row (derivedReady=true,
	// exifStripped=true). Skip re-read if `_known` already reflects state
	// — but markProcessed mutates so we always re-read for safety.
	const refreshed = await deps.repo.getById(input.tenantId, input.propertyId, input.mediaId)
	return {
		media: refreshed ?? media,
		variantCount: result.variants.length,
		derivedKeys: result.variants.map((v) => v.key),
	}
}

/**
 * Promote `mediaId` to hero. Enforces `checkHeroAltText` cross-field
 * invariant. Returns the updated row.
 *
 * Throws if the candidate row has empty altRu (operator must fix BEFORE
 * promoting).
 */
export async function setHeroExclusiveSafe(
	deps: MediaServiceDeps,
	input: {
		readonly tenantId: string
		readonly propertyId: string
		readonly mediaId: string
		readonly actorId: string
	},
): Promise<PropertyMedia> {
	const candidate = await deps.repo.getById(input.tenantId, input.propertyId, input.mediaId)
	if (!candidate) {
		throw new Error(`setHeroExclusiveSafe: media not found: ${input.mediaId}`)
	}
	const violation = checkHeroAltText({ isHero: true, altRu: candidate.altRu })
	if (violation !== null) {
		throw new Error(violation)
	}
	const promoted = await deps.repo.setHeroExclusive(
		input.tenantId,
		input.propertyId,
		input.mediaId,
		input.actorId,
	)
	if (!promoted) {
		throw new Error(
			`setHeroExclusiveSafe: race — media ${input.mediaId} disappeared during promotion`,
		)
	}
	return promoted
}

/**
 * Re-export for routes that want to construct keys without importing the
 * shared helper.
 */
export { buildMediaOriginalKey, type MediaKind }
