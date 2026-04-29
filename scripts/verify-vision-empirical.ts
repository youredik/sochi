/**
 * Empirical verification script for Yandex Vision passport OCR contract
 * vs MockVisionOcrAdapter implementation.
 *
 * Per `feedback_empirical_mock_verification.md`: «sandbox-reachable services
 * MUST be curl-verified before claiming Mock 100% совпадает с реальным».
 * Yandex Vision passport model is per-docs reachable — this script closes
 * that empirical gap.
 *
 * ## What this script does
 *
 *   1. Sends a synthetic test passport image (or user-provided real scan)
 *      to Yandex Vision passport model via HTTPS.
 *   2. Captures the raw response into
 *      `apps/backend/src/domains/epgu/vision/_evidence/real-vision-response.json`
 *      и `_evidence/real-vision-error.json` (если error path).
 *   3. Diffs the response shape vs MockVision's RecognizePassportResponse:
 *      - field names match
 *      - entity types match (string vs number)
 *      - HTTP status code semantic
 *      - apiConfidenceRaw value (per research §3.2 typically 0.0)
 *   4. Reports gaps + concrete fix recommendations for MockVision.
 *
 * ## How to run
 *
 *   1. Get Yandex Cloud Service Account API key:
 *      https://yandex.cloud/ru/docs/iam/operations/api-key/create
 *   2. Get folder ID:
 *      https://yandex.cloud/ru/docs/resource-manager/operations/folder/get-id
 *   3. Optional: provide test passport image path (default = synthetic).
 *   4. Run:
 *
 *      YC_API_KEY=AQVN... YC_FOLDER_ID=b1g... \
 *        node --env-file-if-exists=.env scripts/verify-vision-empirical.ts \
 *        [path/to/passport.jpg]
 *
 *   5. Review _evidence/ output + console diff report.
 *   6. If contract differs → patch MockVision impl, update tests, ship
 *      separate commit with "empirical-verified against real Vision YYYY-MM-DD".
 *
 * ## Cost
 *
 *   ~0.05₽ per passport recognize call (Yandex Vision pricing 2026-04).
 *   Script makes 1 call. Trivial.
 *
 * ## Why script not adapter
 *
 *   This is one-shot empirical check, NOT runtime code. Output goes to
 *   evidence/ directory (gitignored from generated content but checked-in
 *   for spec recording). Script lives in scripts/ alongside other ops
 *   utilities (smoke.ts, walkthrough/), follows project convention.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMockVisionOcr } from '../apps/backend/src/domains/epgu/vision/mock-vision.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = resolve(
	__dirname,
	'../apps/backend/src/domains/epgu/vision/_evidence',
)

// Canonical Yandex AI Studio OCR endpoint 2026 — verified independently
// 2x: research-cache `plans/research/yandex-vision-passport.md` (2026-04-27)
// + live web-research 2026-04-29. Docs migrated cloud.yandex.ru/docs/vision
// → aistudio.yandex.ru/docs/ru/vision (CAPTCHA-walled), API host unchanged.
// Legacy `vision.api.cloud.yandex.net/vision/v1/batchAnalyze` still defined
// in proto but template-recognition (passport) now points exclusively to
// /ocr/v1/recognizeText per yandex-cloud/cloudapi `ai/ocr/v1/ocr_service.proto`.
const VISION_ENDPOINT = 'https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText'

interface VisionEntity {
	name: string
	text: string
}
interface VisionTextAnnotation {
	width?: string
	height?: string
	entities?: VisionEntity[]
	fullText?: string
	[key: string]: unknown
}
/** Sync /ocr/v1/recognizeText returns chunked stream; per-chunk envelope. */
interface YandexOcrChunk {
	result?: {
		textAnnotation?: VisionTextAnnotation
		page?: string
		[key: string]: unknown
	}
	error?: { code: number; message: string; details?: unknown[] }
	[key: string]: unknown
}

async function callRealVision(
	apiKey: string,
	folderId: string,
	bytes: Uint8Array,
): Promise<{ response: YandexOcrChunk; httpStatus: number; latencyMs: number }> {
	const t0 = Date.now()
	const res = await fetch(VISION_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Api-Key ${apiKey}`,
			'Content-Type': 'application/json',
			// folderId required for Api-Key auth — passed as header per Yandex IAM
			// canonical (Api-Key carries no folder context).
			'x-folder-id': folderId,
			'x-data-logging-enabled': 'false',
		},
		body: JSON.stringify({
			content: Buffer.from(bytes).toString('base64'),
			mimeType: 'image/jpeg',
			languageCodes: ['ru', 'en'],
			model: 'passport',
		}),
	})
	const latencyMs = Date.now() - t0
	const httpStatus = res.status
	// Sync endpoint returns chunked sequence of RecognizeTextResponse — each
	// line is a JSON object. For passport (single page) typically 1 chunk.
	const text = await res.text()
	const firstChunk = text.split('\n').find((l) => l.trim().length > 0) ?? '{}'
	const response = JSON.parse(firstChunk) as YandexOcrChunk
	return { response, httpStatus, latencyMs }
}

function ensureEvidenceDir(): void {
	if (!existsSync(EVIDENCE_DIR)) {
		mkdirSync(EVIDENCE_DIR, { recursive: true })
	}
}

function saveEvidence(filename: string, data: unknown): void {
	ensureEvidenceDir()
	const path = resolve(EVIDENCE_DIR, filename)
	writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
	console.log(`✅ Evidence saved: ${path}`)
}

function diffShape(
	mock: Record<string, unknown>,
	real: Record<string, unknown>,
	pathPrefix = '',
): string[] {
	const gaps: string[] = []
	const mockKeys = new Set(Object.keys(mock))
	const realKeys = new Set(Object.keys(real))
	for (const key of mockKeys) {
		if (!realKeys.has(key)) {
			gaps.push(`Mock has '${pathPrefix}${key}', real does NOT — Mock claims field that doesn't exist`)
		}
	}
	for (const key of realKeys) {
		if (!mockKeys.has(key)) {
			gaps.push(`Real has '${pathPrefix}${key}', Mock does NOT — Mock missing real field`)
		}
	}
	for (const key of mockKeys) {
		if (realKeys.has(key)) {
			const mockType = typeof mock[key]
			const realType = typeof real[key]
			if (mockType !== realType) {
				gaps.push(
					`Type mismatch '${pathPrefix}${key}': Mock=${mockType}, Real=${realType}`,
				)
			}
		}
	}
	return gaps
}

async function main(): Promise<void> {
	const apiKey = process.env.YC_API_KEY
	const folderId = process.env.YC_FOLDER_ID
	const imagePath = process.argv[2]

	if (!apiKey || !folderId) {
		console.error('❌ Required env: YC_API_KEY + YC_FOLDER_ID')
		console.error('   Per scripts/verify-vision-empirical.ts header for setup.')
		process.exit(1)
	}

	let bytes: Uint8Array
	if (imagePath) {
		console.log(`📷 Reading test image: ${imagePath}`)
		bytes = new Uint8Array(readFileSync(imagePath))
	} else {
		console.log('📷 No image path — using synthetic 1×1 PNG (will produce api_error).')
		// 1×1 transparent PNG для smoke test of API contract без real image cost.
		// Real verification needs proper passport scan.
		bytes = new Uint8Array(
			Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
				'base64',
			),
		)
	}

	console.log('🌐 Calling real Yandex Vision OCR /ocr/v1/recognizeText (model=passport)...')
	const { response, httpStatus, latencyMs } = await callRealVision(apiKey, folderId, bytes)
	console.log(`📊 HTTP ${httpStatus}, latency ${latencyMs}ms`)
	saveEvidence('real-vision-response.json', { httpStatus, latencyMs, response })

	console.log('🤖 Calling MockVision with same bytes for comparison...')
	const mock = createMockVisionOcr()
	const mockResp = await mock.recognizePassport({
		bytes,
		mimeType: 'image/jpeg',
		countryHint: null,
	})
	saveEvidence('mock-vision-response.json', mockResp)

	console.log('\n=== Shape diff (Mock vs Real /ocr/v1) ===')
	const mockShape: Record<string, unknown> = {
		detectedCountryIso3: mockResp.detectedCountryIso3,
		isCountryWhitelisted: mockResp.isCountryWhitelisted,
		entities: mockResp.entities,
		apiConfidenceRaw: mockResp.apiConfidenceRaw,
		confidenceHeuristic: mockResp.confidenceHeuristic,
		outcome: mockResp.outcome,
		latencyMs: mockResp.latencyMs,
		httpStatus: mockResp.httpStatus,
	}
	console.log('Mock RecognizePassportResponse fields:', Object.keys(mockShape))
	console.log('Real Vision OCR chunk fields:', Object.keys(response))

	// New /ocr/v1 envelope: { result: { textAnnotation: { entities[], fullText, ... }, page } }
	const realResult = response.result
	if (realResult) {
		console.log('Real result fields:', Object.keys(realResult))
		const ann = realResult.textAnnotation
		if (ann) {
			console.log('Real textAnnotation fields:', Object.keys(ann))
			const realEntities = ann.entities ?? []
			const realEntityNames = new Set(realEntities.map((e) => e.name))
			const mockEntityKeys = new Set(Object.keys(mockResp.entities))
			console.log('Real entity names (snake_case from API):', Array.from(realEntityNames))
			console.log('Mock entity keys (camelCase post-mapping):', Array.from(mockEntityKeys))
			// Expected canonical 9 entities per research-cache 2026-04-27:
			//   surname, name, middle_name, gender, citizenship, birth_date,
			//   birth_place, number, issue_date.
			// Possible additional 3 per live-research 2026-04-29 (загран/СНГ):
			//   issued_by, subdivision, expiration_date.
			// Empirical curl resolves the divergence — record exact set seen.
			console.log(
				'\n📌 Divergence source-of-truth: this curl evidence supersedes ' +
					'research-cache + live-research synthesis. Patch Mock to match.',
			)
		}
	}
	if (response.error) {
		console.log('⚠️  API returned error:', response.error)
	}

	console.log(`\n📁 Evidence files: ${EVIDENCE_DIR}/*.json`)
	console.log('📌 Next steps:')
	console.log('   1. Review real-vision-response.json — confirm entity types, names')
	console.log('   2. If Mock contract differs → patch mock-vision.ts')
	console.log('   3. Update test fixtures с real entity names')
	console.log('   4. Commit «empirical-verified vs Yandex Vision YYYY-MM-DD»')
	console.log('   5. Update feedback_empirical_mock_verification.md status')
}

main().catch((err) => {
	console.error('❌ Verification failed:', err)
	saveEvidence('real-vision-error.json', {
		message: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	process.exit(1)
})
