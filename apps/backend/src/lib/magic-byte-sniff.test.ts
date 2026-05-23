/**
 * Magic-byte sniffer — strict tests per feedback_strict_tests.md.
 */
import { describe, expect, test } from 'bun:test'
import { assertMimeMatchesBytes, sniffMagicBytes } from './magic-byte-sniff.ts'

describe('sniffMagicBytes', () => {
	test('returns jpeg for JPEG SOI marker FF D8 FF E0', () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
		expect(sniffMagicBytes(bytes)).toBe('jpeg')
	})

	test('returns jpeg for JPEG SOI with different APP marker FF D8 FF DB', () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xdb])
		expect(sniffMagicBytes(bytes)).toBe('jpeg')
	})

	test('returns png for PNG signature 89 50 4E 47', () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		expect(sniffMagicBytes(bytes)).toBe('png')
	})

	test('returns pdf for ASCII %PDF', () => {
		const bytes = new TextEncoder().encode('%PDF-1.7\n')
		expect(sniffMagicBytes(bytes)).toBe('pdf')
	})

	test('returns heic for HEIC ftyp + heic brand', () => {
		// 4-byte box size + 'ftyp' (66 74 79 70) + 'heic' brand (68 65 69 63)
		const bytes = new Uint8Array([
			0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
		])
		expect(sniffMagicBytes(bytes)).toBe('heic')
	})

	test('returns heic for HEIF mif1 brand', () => {
		const bytes = new Uint8Array([
			0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31,
		])
		expect(sniffMagicBytes(bytes)).toBe('heic')
	})

	test('returns unknown for too-short input (<4 bytes)', () => {
		expect(sniffMagicBytes(new Uint8Array([0xff, 0xd8]))).toBe('unknown')
		expect(sniffMagicBytes(new Uint8Array(0))).toBe('unknown')
	})

	test('returns unknown for random non-image bytes', () => {
		const bytes = new TextEncoder().encode('<script>alert(1)</script>')
		expect(sniffMagicBytes(bytes)).toBe('unknown')
	})

	test('does NOT confuse JPEG FF D8 (без 3-rd FF) с partial signature', () => {
		// Just FF D8 без FF — invalid JPEG
		const bytes = new Uint8Array([0xff, 0xd8, 0x00, 0x00])
		expect(sniffMagicBytes(bytes)).toBe('unknown')
	})
})

describe('assertMimeMatchesBytes', () => {
	test('accepts matching image/jpeg + JPEG bytes', () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
		expect(assertMimeMatchesBytes('image/jpeg', bytes)).toEqual({ ok: true })
	})

	test('accepts matching image/png + PNG bytes', () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
		expect(assertMimeMatchesBytes('image/png', bytes)).toEqual({ ok: true })
	})

	test('accepts matching application/pdf + PDF bytes', () => {
		const bytes = new TextEncoder().encode('%PDF-1.7\n')
		expect(assertMimeMatchesBytes('application/pdf', bytes)).toEqual({ ok: true })
	})

	test('rejects MIME spoof: image/jpeg label + PNG bytes', () => {
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
		const result = assertMimeMatchesBytes('image/jpeg', bytes)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected mismatch')
		expect(result.declared).toBe('image/jpeg')
		expect(result.detected).toBe('png')
		expect(result.reason).toContain('MIME mismatch')
	})

	test('rejects HEIC bytes with image/jpeg label (with HEIC-specific reason)', () => {
		const bytes = new Uint8Array([
			0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
		])
		const result = assertMimeMatchesBytes('image/jpeg', bytes)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected mismatch')
		expect(result.detected).toBe('heic')
		expect(result.reason).toContain('HEIC')
	})

	test('rejects unsupported declared MIME (image/webp)', () => {
		const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
		const result = assertMimeMatchesBytes('image/webp', bytes)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected unsupported')
		expect(result.reason).toContain('Unsupported MIME type')
	})

	test('rejects bytes too short (length < 4)', () => {
		const bytes = new Uint8Array([0xff, 0xd8])
		const result = assertMimeMatchesBytes('image/jpeg', bytes)
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected mismatch')
		expect(result.detected).toBe('unknown')
	})
})
