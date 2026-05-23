/**
 * Client-side image transcoding для Yandex Vision OCR.
 *
 * Why: Yandex Vision принимает только JPEG/PNG/PDF — HEIC от iPhone
 * отвергается (HTTP 415/400). Также 12MP+ фото бесполезны для OCR паспорта
 * и раздувают трафик. Канон 2026 (Mobile UX research §4):
 *
 *   createImageBitmap(file, {imageOrientation:'from-image'})
 *   → canvas.drawImage (resize до 2048px max edge)
 *   → canvas.toBlob('image/jpeg', 0.85)
 *
 * Bonuses (всё бесплатно из этого pipeline):
 *   - EXIF strip (canvas пишет fresh JPEG без metadata → geolocation
 *     iPhone не утекает на backend, защита 152-ФЗ data minimization)
 *   - Auto-rotation (createImageBitmap honors EXIF Orientation tag)
 *   - HEIC → JPEG автоматически (iOS Safari декодирует HEIC через
 *     ImageBitmap → выход всегда канвасные пиксели → JPEG энкод)
 *
 * 0 dependencies. Все API стандартные браузерные.
 */

/**
 * Max длина любой стороны output. Vision sweet spot для passport.
 * Research §2 (raw): паспорт читается с >=1500px резкости; 2048 даёт
 * запас + не превышает Vision лимит 20 МП.
 */
const MAX_DIMENSION = 2048

/**
 * JPEG quality. 0.85 = industry canon 2026 (Klippa SDK default; +60%
 * sharpness vs 0.6 при ~20% росте байтов).
 */
const JPEG_QUALITY = 0.85

export interface TranscodeResult {
	readonly file: File
	/** Output size в bytes (для logging / cost monitoring). */
	readonly outputBytes: number
	readonly outputWidth: number
	readonly outputHeight: number
}

/**
 * Transcode произвольный File → JPEG suitable for Yandex Vision.
 *
 * Throws с RU-сообщением (operator-facing) если:
 *   - file пустой (size === 0)
 *   - createImageBitmap fails (corrupted bytes / unsupported codec)
 *   - canvas 2D context недоступен (very old browser)
 *   - canvas.toBlob возвращает null (out-of-memory)
 *
 * Caller responsibility — обернуть в try/catch и показать оператору.
 */
export async function transcodeToJpegForVision(file: File): Promise<TranscodeResult> {
	if (file.size === 0) {
		throw new Error('Файл пустой')
	}

	let bitmap: ImageBitmap
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		throw new Error(`Не удалось декодировать изображение: ${reason}`)
	}

	// Canvas создаётся вне try чтобы cleanup был в finally (iOS Safari canvas
	// GPU-buffer leak per WebKit #229825 — без явного `width=0;height=0`
	// reset 2048×2048 RGBA buffer = 16 MB persists per scan, OOM на iPhone SE
	// после 4-5 сканов).
	const canvas = document.createElement('canvas')
	try {
		const srcW = bitmap.width
		const srcH = bitmap.height
		if (srcW === 0 || srcH === 0) {
			throw new Error('Изображение имеет нулевые размеры')
		}
		const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH))
		const dstW = Math.max(1, Math.round(srcW * scale))
		const dstH = Math.max(1, Math.round(srcH * scale))

		canvas.width = dstW
		canvas.height = dstH
		const ctx = canvas.getContext('2d')
		if (ctx === null) {
			throw new Error('Canvas 2D context недоступен (старый браузер)')
		}
		ctx.drawImage(bitmap, 0, 0, dstW, dstH)

		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
		)
		if (blob === null) {
			throw new Error('Не удалось закодировать в JPEG (нехватка памяти?)')
		}

		const baseName = file.name.replace(/\.[^.]+$/, '') || 'scan'
		const outFile = new File([blob], `${baseName}.jpg`, {
			type: 'image/jpeg',
			lastModified: Date.now(),
		})
		return {
			file: outFile,
			outputBytes: outFile.size,
			outputWidth: dstW,
			outputHeight: dstH,
		}
	} finally {
		bitmap.close()
		// iOS Safari GPU-buffer cleanup canon — reset canvas dimensions
		// освобождает backing-store memory (WebKit #229825). Без этого 5
		// сканов = OOM на бюджетных iPhone.
		canvas.width = 0
		canvas.height = 0
	}
}

/**
 * Encode File/Blob в base64 без stack-overflow для крупных файлов.
 *
 * `btoa(String.fromCharCode(...new Uint8Array(buf)))` через spread ломается
 * при больших buf (call-stack limit). FileReader.readAsDataURL — native,
 * async, без stack issues.
 *
 * Returns: чистый base64 без `data:...;base64,` префикса.
 */
export async function fileToBase64(file: File | Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => {
			const result = reader.result
			if (typeof result !== 'string') {
				reject(new Error('FileReader returned non-string'))
				return
			}
			const commaIdx = result.indexOf(',')
			if (commaIdx === -1) {
				reject(new Error('FileReader result не data-URL'))
				return
			}
			resolve(result.slice(commaIdx + 1))
		}
		reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
		reader.readAsDataURL(file)
	})
}
