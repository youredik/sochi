import { env } from '../../env.ts'
import { getStubMediaStorage, type MediaStorage } from './media-storage.ts'
import { getYandexS3MediaStorage } from './media-storage-yandex-s3.ts'

/**
 * `getMediaStorage()` — production-aware dispatcher.
 *
 * **M9.7 dispatch logic:**
 *   - `APP_MODE=production` → Yandex S3 production adapter (real Object
 *     Storage upload + presign via AWS SDK v3)
 *   - `APP_MODE=sandbox` (default dev/CI) → in-process Stub
 *
 * Lives in separate file from `media-storage.ts` для разрыва circular
 * import: yandex-s3 needs the `MediaStorage` interface from media-storage.ts;
 * if media-storage.ts imports yandex-s3 → cycle. Single-direction:
 * media-storage.ts → (no deps), media-storage-yandex-s3.ts → media-storage.ts,
 * media-storage-resolve.ts → both.
 */
let cached: MediaStorage | null = null

export function getMediaStorage(): MediaStorage {
	if (cached) return cached
	if (env.APP_MODE === 'production') {
		cached = getYandexS3MediaStorage({
			endpoint: env.S3_ENDPOINT,
			region: env.S3_REGION,
			accessKeyId: env.S3_ACCESS_KEY_ID,
			secretAccessKey: env.S3_SECRET_ACCESS_KEY,
			bucket: env.S3_BUCKET,
		})
		return cached
	}
	cached = getStubMediaStorage()
	return cached
}
