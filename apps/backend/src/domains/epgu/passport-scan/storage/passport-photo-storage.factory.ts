/**
 * Passport photo storage factory — env-driven `disabled | mock | yandex` selection.
 *
 * Aligns с canon `feedback_behaviour_faithful_mock_canon.md` + `feedback_yandex_cloud_only.md`.
 * Mock returns canonical-shape key без actual upload; production swaps via env.
 */

import type { AdapterMetadata } from '../../../../lib/adapters/types.ts'
import {
	createDisabledPassportPhotoStorage,
	createMockPassportPhotoStorage,
	createYandexS3PassportStorage,
	type PassportPhotoStorage,
} from './passport-photo-storage.ts'

export interface PassportPhotoStorageFactoryEnv {
	readonly storageProvider: 'disabled' | 'mock' | 'yandex'
	readonly appMode: 'sandbox' | 'production'
	readonly s3Endpoint: string | undefined
	readonly s3Region: string | undefined
	readonly s3AccessKeyId: string | undefined
	readonly s3SecretAccessKey: string | undefined
	readonly s3Bucket: string | undefined
}

export interface CreatePassportPhotoStorageResult {
	readonly adapter: PassportPhotoStorage
	readonly metadata: AdapterMetadata
}

export function createPassportPhotoStorageFromEnv(
	env: PassportPhotoStorageFactoryEnv,
): CreatePassportPhotoStorageResult {
	if (env.storageProvider === 'disabled') {
		return {
			adapter: createDisabledPassportPhotoStorage(),
			metadata: {
				name: 'passport-photo-storage.disabled',
				category: 'storage',
				mode: 'mock',
				description:
					'Passport photo storage disabled — inputObjectKey=null в audit log. Phase 1 minimal mode.',
			},
		}
	}
	if (env.storageProvider === 'mock') {
		return {
			adapter: createMockPassportPhotoStorage(),
			metadata: {
				name: 'passport-photo-storage.mock',
				category: 'storage',
				mode: 'mock',
				description:
					'Behaviour-faithful mock — canonical key generation без S3 PUT. Switch к yandex при scaling.',
			},
		}
	}
	// yandex
	if (
		!env.s3Endpoint ||
		!env.s3Region ||
		!env.s3AccessKeyId ||
		!env.s3SecretAccessKey ||
		!env.s3Bucket
	) {
		throw new Error(
			'PASSPORT_PHOTO_STORAGE=yandex requires S3_ENDPOINT + S3_REGION + S3_ACCESS_KEY_ID + S3_SECRET_ACCESS_KEY + S3_BUCKET (или S3_BUCKET_PASSPORT_SCANS). См. env.ts.',
		)
	}
	const adapter = createYandexS3PassportStorage({
		endpoint: env.s3Endpoint,
		region: env.s3Region,
		accessKeyId: env.s3AccessKeyId,
		secretAccessKey: env.s3SecretAccessKey,
		bucket: env.s3Bucket,
	})
	return {
		adapter,
		metadata: {
			name: 'passport-photo-storage.yandex',
			category: 'storage',
			mode: env.appMode === 'production' ? 'live' : 'sandbox',
			description:
				'Yandex Object Storage (S3-compatible) — SSE-S3 encryption-at-rest + 90-day lifecycle policy (canonical via Terraform). path=tenant/{tenantId}/passport/{uuid}.{ext}',
			providerVersion: 'v1',
		},
	}
}
