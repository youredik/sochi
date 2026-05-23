/**
 * Magic-byte sniffing для image upload validation (Sprint B, 2026-05-22).
 *
 * WHY: Zod enum проверяет header `mimeType` поле — но это всего лишь СТРОКА
 * от клиента, которая может быть подделана. Атакующий пошлёт
 * `mimeType: 'image/jpeg'` с реально HEIC/PNG/garbage bytes — Vision вернёт
 * 415/400, а мы:
 *   - сожгли Yandex quota (0.71 ₽ × N attacks)
 *   - cluttered audit log с confused state
 *   - пропустили MIME spoof в downstream pipeline (если будет storage)
 *
 * Defense-in-depth: проверить первые 3-4 байта против known magic numbers.
 *
 * Sources:
 *   - JPEG: ISO/IEC 10918-1 — SOI marker = FF D8 FF (followed by FF Ex variant)
 *   - PNG:  RFC 2083 — 89 50 4E 47 0D 0A 1A 0A (8-byte signature)
 *   - PDF:  ISO 32000-2 §7.5.2 — `%PDF-` = 25 50 44 46 2D (always at offset 0)
 *
 * HEIC explicitly NOT supported (Vision rejects HEIC per round 2 research) —
 * detected separately to return distinct error message.
 */

export type DetectedFormat = 'jpeg' | 'png' | 'pdf' | 'heic' | 'unknown'

/**
 * Inspect первые 16 байт и определить реальный формат.
 *
 * Returns 'unknown' если bytes слишком короткие или не matches none of
 * supported signatures. Caller decides — reject or accept-with-warning.
 */
export function sniffMagicBytes(bytes: Uint8Array): DetectedFormat {
	if (bytes.length < 4) return 'unknown'
	// JPEG: FF D8 FF (4-th byte = APP marker variant, не check)
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
	// PNG: 89 50 4E 47 (full 8-byte sig: 89 50 4E 47 0D 0A 1A 0A, проверим первые 4)
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
	// PDF: 25 50 44 46 ('%PDF')
	if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf'
	// HEIC: ISO BMFF ftyp box. Bytes 4-7 = 'ftyp', bytes 8-11 = brand ('heic', 'heix', 'mif1')
	// First 4 bytes — box size (varies), не constant. Check 'ftyp' at offset 4-7.
	if (
		bytes.length >= 12 &&
		bytes[4] === 0x66 && // 'f'
		bytes[5] === 0x74 && // 't'
		bytes[6] === 0x79 && // 'y'
		bytes[7] === 0x70 && // 'p'
		// Brand at offset 8-11: heic/heix/mif1/heim/heis
		((bytes[8] === 0x68 && bytes[9] === 0x65 && bytes[10] === 0x69 && bytes[11] === 0x63) || // 'heic'
			(bytes[8] === 0x68 && bytes[9] === 0x65 && bytes[10] === 0x69 && bytes[11] === 0x78) || // 'heix'
			(bytes[8] === 0x6d && bytes[9] === 0x69 && bytes[10] === 0x66 && bytes[11] === 0x31)) // 'mif1' (HEIF generic)
	) {
		return 'heic'
	}
	return 'unknown'
}

/** Map declared MIME header → expected magic-byte format. */
const MIME_TO_FORMAT: ReadonlyMap<string, DetectedFormat> = new Map([
	['image/jpeg', 'jpeg'],
	['image/png', 'png'],
	['application/pdf', 'pdf'],
])

export type MimeCheckResult =
	| { readonly ok: true }
	| {
			readonly ok: false
			readonly declared: string
			readonly detected: DetectedFormat
			readonly reason: string
	  }

/**
 * Verify что declared MIME (frontend header) совпадает с magic bytes (actual
 * content). Returns ok=true только если оба matches и format supported.
 *
 * Цели:
 *   1. Reject MIME spoofing атаки (image/jpeg label + HEIC bytes)
 *   2. Catch frontend transcode bugs (label не обновлён после Canvas re-encode)
 *   3. Reject unsupported formats explicitly (HEIC попал в обход frontend transcode)
 */
export function assertMimeMatchesBytes(declaredMime: string, bytes: Uint8Array): MimeCheckResult {
	const expected = MIME_TO_FORMAT.get(declaredMime)
	if (expected === undefined) {
		return {
			ok: false,
			declared: declaredMime,
			detected: sniffMagicBytes(bytes),
			reason: `Unsupported MIME type: ${declaredMime}`,
		}
	}
	const detected = sniffMagicBytes(bytes)
	if (detected !== expected) {
		return {
			ok: false,
			declared: declaredMime,
			detected,
			reason:
				detected === 'heic'
					? 'HEIC bytes detected — Yandex Vision не принимает HEIC. Клиент должен конвертировать в JPEG.'
					: `MIME mismatch: declared ${declaredMime}, detected ${detected}`,
		}
	}
	return { ok: true }
}
