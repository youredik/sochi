import type { sql as SQL } from '../../db/index.ts'
import { createAddonsRepo } from './addons.repo.ts'
import { createAmenitiesRepo } from './amenities.repo.ts'
import { createPropertyDescriptionsRepo } from './descriptions.repo.ts'
import { createMediaRepo } from './media.repo.ts'
import type { MediaStorage } from './media-storage.ts'
import { getMediaStorage } from './media-storage-resolve.ts'

/**
 * Wires up M8.A.0 property-content domain (amenities + descriptions +
 * media + addons). All routes share a single factory to minimise app.ts
 * bootstrap noise.
 */
export function createPropertyContentFactory(
	sql: typeof SQL,
	opts: { mediaStorage?: MediaStorage } = {},
) {
	const amenities = createAmenitiesRepo(sql)
	const descriptions = createPropertyDescriptionsRepo(sql)
	const media = createMediaRepo(sql)
	const addons = createAddonsRepo(sql)
	const mediaStorage = opts.mediaStorage ?? getMediaStorage()
	return { amenities, descriptions, media, addons, mediaStorage }
}

export type PropertyContentFactory = ReturnType<typeof createPropertyContentFactory>
