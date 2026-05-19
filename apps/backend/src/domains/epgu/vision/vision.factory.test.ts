/**
 * Vision adapter factory — strict tests (P2, 2026-05).
 *
 * Symmetric с payment factory test pattern.
 */

import { describe, expect, test } from 'bun:test'
import { createVisionAdapterFromEnv, type VisionFactoryEnv } from './vision.factory.ts'

const VALID_YC: Pick<VisionFactoryEnv, 'ycVisionApiKey' | 'ycVisionFolderId'> = {
	ycVisionApiKey: 'AQVN_test_api_key',
	ycVisionFolderId: 'b1g_test_folder_id',
}

const MOCK_BASELINE: Omit<VisionFactoryEnv, 'visionProvider' | 'appMode'> = {
	ycVisionApiKey: undefined,
	ycVisionFolderId: undefined,
}

describe('createVisionAdapterFromEnv', () => {
	describe('mock adapter', () => {
		test('returns mock adapter в default dev mode', () => {
			const { adapter, metadata } = createVisionAdapterFromEnv({
				visionProvider: 'mock',
				appMode: 'sandbox',
				...MOCK_BASELINE,
			})
			expect(adapter.source).toBe('mock_vision')
			expect(metadata.name).toBe('vision.mock')
			expect(metadata.category).toBe('vision')
			expect(metadata.mode).toBe('mock')
		})

		test('mock mode unchanged at APP_MODE=production (refused later by assertProductionReady)', () => {
			const { metadata } = createVisionAdapterFromEnv({
				visionProvider: 'mock',
				appMode: 'production',
				...MOCK_BASELINE,
			})
			expect(metadata.mode).toBe('mock')
		})
	})

	describe('yandex adapter', () => {
		test('returns yandex adapter with sandbox metadata at APP_MODE=sandbox', () => {
			const { adapter, metadata } = createVisionAdapterFromEnv({
				visionProvider: 'yandex',
				appMode: 'sandbox',
				...VALID_YC,
			})
			expect(adapter.source).toBe('yandex_vision')
			expect(metadata.name).toBe('vision.yandex')
			expect(metadata.category).toBe('vision')
			expect(metadata.mode).toBe('sandbox')
			expect(metadata.providerVersion).toBe('v1')
		})

		test('returns yandex with live metadata at APP_MODE=production', () => {
			const { metadata } = createVisionAdapterFromEnv({
				visionProvider: 'yandex',
				appMode: 'production',
				...VALID_YC,
			})
			expect(metadata.mode).toBe('live')
		})

		test('rejects missing apiKey', () => {
			expect(() =>
				createVisionAdapterFromEnv({
					visionProvider: 'yandex',
					appMode: 'sandbox',
					ycVisionApiKey: undefined,
					ycVisionFolderId: 'b1g_test',
				}),
			).toThrow(/YC_VISION_API_KEY/)
		})

		test('rejects missing folderId', () => {
			expect(() =>
				createVisionAdapterFromEnv({
					visionProvider: 'yandex',
					appMode: 'sandbox',
					ycVisionApiKey: 'AQVN_test',
					ycVisionFolderId: undefined,
				}),
			).toThrow(/YC_VISION_API_KEY/)
		})

		test('rejects empty-string apiKey (defensive)', () => {
			expect(() =>
				createVisionAdapterFromEnv({
					visionProvider: 'yandex',
					appMode: 'sandbox',
					ycVisionApiKey: '',
					ycVisionFolderId: 'b1g_test',
				}),
			).toThrow(/YC_VISION_API_KEY/)
		})
	})

	describe('exhaustive switch (unknown provider)', () => {
		test('throws on unrecognized provider value', () => {
			expect(() =>
				createVisionAdapterFromEnv({
					// @ts-expect-error — runtime escape, simulates corrupt env
					visionProvider: 'unknown-vision',
					appMode: 'sandbox',
					...MOCK_BASELINE,
				}),
			).toThrow(/Unknown VISION_PROVIDER/)
		})
	})
})
