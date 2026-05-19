/**
 * Vision OCR adapter factory — env-driven `mock | yandex` selection (P2, 2026-05-19).
 *
 * Symmetric с payment provider factory pattern:
 *   - `mock`                            → `vision.mock`   mode='mock'
 *   - `yandex` + APP_MODE=sandbox       → `vision.yandex` mode='sandbox'
 *   - `yandex` + APP_MODE=production    → `vision.yandex` mode='live'
 *
 * `assertProductionReady()` (registry.ts) rejects startup if mode='mock' OR
 * 'sandbox' under APP_MODE=production без explicit whitelist.
 */

import type { AdapterMetadata } from '../../../lib/adapters/types.ts'
import { createMockVisionOcr } from './mock-vision.ts'
import type { VisionOcrAdapter } from './types.ts'
import { createYandexVisionOcr } from './yandex-vision-provider.ts'

/**
 * Subset of `env` consumed by the vision factory. Explicit subset (not
 * dependency on `env.ts`) keeps factory unit-testable without booting
 * the whole env schema.
 */
export type VisionFactoryEnv = {
	visionProvider: 'mock' | 'yandex'
	appMode: 'sandbox' | 'production'
	ycVisionApiKey: string | undefined
	ycVisionFolderId: string | undefined
}

export type CreateVisionAdapterResult = {
	adapter: VisionOcrAdapter
	metadata: AdapterMetadata
}

export function createVisionAdapterFromEnv(env: VisionFactoryEnv): CreateVisionAdapterResult {
	if (env.visionProvider === 'mock') {
		return {
			adapter: createMockVisionOcr(),
			metadata: {
				name: 'vision.mock',
				category: 'vision',
				mode: 'mock',
				description:
					'Behaviour-faithful Yandex Vision passport OCR (9 entities, 20-country whitelist, ' +
					'computeHeuristicConfidence ввиду apiConfidenceRaw broken upstream). Switch to ' +
					'VISION_PROVIDER=yandex when YC creds available.',
			},
		}
	}
	if (env.visionProvider === 'yandex') {
		// `env.refine` уже гарантирует обоих, но defensive narrowing для control-flow.
		if (!env.ycVisionApiKey || !env.ycVisionFolderId) {
			throw new Error(
				'VISION_PROVIDER=yandex requires YC_VISION_API_KEY + YC_VISION_FOLDER_ID. ' +
					'Get free signup grant (4 000 ₽ / 60 days) at https://yandex.cloud/ — service ' +
					'account needs role `ai.vision.user`.',
			)
		}
		const adapter = createYandexVisionOcr({
			apiKey: env.ycVisionApiKey,
			folderId: env.ycVisionFolderId,
		})
		return {
			adapter,
			metadata: {
				name: 'vision.yandex',
				category: 'vision',
				mode: env.appMode === 'production' ? 'live' : 'sandbox',
				description:
					'Yandex Cloud OCR /ocr/v1/recognizeText (model=passport). Api-Key + x-folder-id ' +
					'auth, Idempotency-Key dedup (Yandex Cloud canon — IETF spelling), chunked-stream ' +
					'response. Test mode = grant-funded sandbox; live mode = production billing.',
				providerVersion: 'v1',
			},
		}
	}
	// Closed enum exhausted; exhaustive switch для future provider additions.
	const _exhaustive: never = env.visionProvider
	throw new Error(`Unknown VISION_PROVIDER: ${String(_exhaustive)}`)
}
