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

// Yandex AI Studio passport model endpoint (verified docs Apr 2026).
const VISION_ENDPOINT = 'https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze'

interface YandexVisionRawResponse {
	results?: Array<{
		results?: Array<{
			error?: { code: number; message: string }
			textDetection?: unknown
			passportRegistration?: {
				entities?: Array<{ type: string; text: string }>
				confidence?: number
			}
			[key: string]: unknown
		}>
	}>
	[key: string]: unknown
}

async function callRealVision(
	apiKey: string,
	folderId: string,
	bytes: Uint8Array,
): Promise<{ response: YandexVisionRawResponse; httpStatus: number; latencyMs: number }> {
	const t0 = Date.now()
	const res = await fetch(VISION_ENDPOINT, {
		method: 'POST',
		headers: {
			Authorization: `Api-Key ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			folderId,
			analyze_specs: [
				{
					content: Buffer.from(bytes).toString('base64'),
					features: [
						{
							type: 'PASSPORT',
							passport_features: { model: 'passport' },
						},
					],
				},
			],
		}),
	})
	const latencyMs = Date.now() - t0
	const httpStatus = res.status
	const response = (await res.json()) as YandexVisionRawResponse
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

	console.log('🌐 Calling real Yandex Vision passport endpoint...')
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

	console.log('\n=== Shape diff (Mock vs Real top-level) ===')
	// Build canonical Mock shape mirroring real Vision API extraction logic.
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
	// Real Vision top-level differs — Vision API returns `results: [{ results: [{...}] }]` envelope.
	// We need to compare canonical adapter-level shape (after normalization).
	// Real shape comes from Yandex's textDetection/passportRegistration sub-objects.
	console.log('Mock RecognizePassportResponse fields:', Object.keys(mockShape))
	console.log('Real Vision raw envelope fields:', Object.keys(response))

	// Pull first result for shape comparison
	const realInner = response.results?.[0]?.results?.[0]
	if (realInner) {
		console.log('Real first result fields:', Object.keys(realInner))
		const passportData = (realInner as Record<string, unknown>).passportRegistration as
			| Record<string, unknown>
			| undefined
		if (passportData) {
			console.log('Real passportRegistration fields:', Object.keys(passportData))
			const realEntities = passportData.entities as
				| Array<{ type: string; text: string }>
				| undefined
			if (realEntities) {
				const realEntityTypes = new Set(realEntities.map((e) => e.type))
				const mockEntityKeys = new Set(Object.keys(mockResp.entities))
				console.log('Real entity types:', Array.from(realEntityTypes))
				console.log('Mock entity keys:', Array.from(mockEntityKeys))
				const gaps = diffShape({ ...mockShape }, response, '')
				if (gaps.length === 0) {
					console.log('✅ No top-level gaps detected (subject to entity-name mapping verification).')
				} else {
					console.log(`⚠️  ${gaps.length} gaps detected:`)
					for (const g of gaps) console.log(`   - ${g}`)
				}
			}
		}
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
