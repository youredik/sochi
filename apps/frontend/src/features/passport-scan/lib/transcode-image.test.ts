/**
 * Unit tests for transcode-image.ts pure utilities.
 *
 * Real createImageBitmap + canvas.toBlob path validated в Playwright
 * passport-scan e2e (Phase 6) — happy-dom 20 не имеет native canvas
 * implementation, поэтому здесь мы покрываем pure-logic ветки + edge cases.
 */
import { describe, expect, test } from 'bun:test'
import { fileToBase64, transcodeToJpegForVision } from './transcode-image.ts'

describe('transcodeToJpegForVision', () => {
	test('throws "Файл пустой" для File с size === 0', async () => {
		const emptyFile = new File([], 'scan.heic', { type: 'image/heic' })
		expect(emptyFile.size).toBe(0)
		await expect(transcodeToJpegForVision(emptyFile)).rejects.toThrow('Файл пустой')
	})

	test('throws с RU-сообщением когда createImageBitmap fails (corrupted)', async () => {
		// File с garbage bytes — createImageBitmap отвергнет
		const garbage = new File([new Uint8Array([0xff, 0x00, 0xff, 0x00])], 'fake.jpg', {
			type: 'image/jpeg',
		})
		await expect(transcodeToJpegForVision(garbage)).rejects.toThrow(
			/Не удалось декодировать изображение/,
		)
	})
})

describe('fileToBase64', () => {
	test('encodes plain text Blob correctly', async () => {
		const blob = new Blob(['Hello, World!'], { type: 'text/plain' })
		const result = await fileToBase64(blob)
		// 'Hello, World!' = "SGVsbG8sIFdvcmxkIQ==" в base64
		expect(result).toBe('SGVsbG8sIFdvcmxkIQ==')
	})

	test('strips `data:...;base64,` prefix from FileReader output', async () => {
		const blob = new Blob(['x'], { type: 'image/png' })
		const result = await fileToBase64(blob)
		// 'x' = 'eA==' в base64
		expect(result).toBe('eA==')
		expect(result).not.toContain('data:')
		expect(result).not.toContain(',')
	})

	test('encodes binary bytes correctly (Uint8Array → base64)', async () => {
		// Bytes [0, 1, 255] → 'AAH/' в base64
		const blob = new Blob([new Uint8Array([0, 1, 255])], { type: 'application/octet-stream' })
		const result = await fileToBase64(blob)
		expect(result).toBe('AAH/')
	})

	test('handles empty Blob (returns empty base64)', async () => {
		const blob = new Blob([], { type: 'application/octet-stream' })
		const result = await fileToBase64(blob)
		expect(result).toBe('')
	})
})
