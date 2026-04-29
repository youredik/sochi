/**
 * Empirical verification script for ЮKassa /v3/ contract vs our payment-domain
 * canon (`memory project_yookassa_canon_corrections.md` + research-cache
 * `plans/research/yookassa-54fz.md`).
 *
 * Per `feedback_empirical_mock_verification.md`: «sandbox-reachable services
 * MUST be curl-verified before claiming Stub/adapter behaviour-faithful».
 *
 * ## What this script does
 *
 *   1. Verifies HTTP Basic auth shopId:secretKey works (`GET /v3/me`).
 *   2. Creates ONE minimal test payment (sandbox, no real money).
 *   3. Creates ONE test payment with 54-ФЗ receipt (vat_code=11 — НДС 22%
 *      from 2026-01-01, payment_subject="service" for accommodation).
 *   4. Captures both raw responses to
 *      `apps/backend/src/domains/payment/_evidence/real-yookassa-*.json`.
 *   5. Diffs against canon expectations:
 *      - status enum: `pending|waiting_for_capture|succeeded|canceled`
 *      - confirmation.confirmation_url shape
 *      - Idempotence-Key behaviour (replay-safety)
 *      - vat_code 11 acceptance in receipt
 *      - test:true flag in response
 *   6. Reports gaps + concrete fix recommendations.
 *
 * ## How to run
 *
 *   1. ЛК ЮKassa → Test mode toggle → создать test shop (бесплатно).
 *   2. Скопировать test shopId + test secretKey.
 *   3. Add to .env:
 *
 *      YOOKASSA_TEST_SHOP_ID=...
 *      YOOKASSA_TEST_SECRET_KEY=...
 *
 *   4. Run:
 *
 *      node --env-file-if-exists=.env scripts/verify-yookassa-empirical.ts
 *
 *   5. Review _evidence/ output + console diff report.
 *   6. If contract differs → patch payment-domain canon, ship commit
 *      «empirical-verified vs YooKassa YYYY-MM-DD».
 *
 * ## Cost
 *
 *   ZERO. Test mode is fully free (no real money, sandbox-only).
 *   Script makes 3 HTTPS requests (auth check + 2 payments).
 *
 * ## Webhook NOT covered
 *
 *   ЮKassa webhook delivery requires public HTTPS endpoint (ngrok / cloudflared).
 *   Webhook empirical testing is a separate manual flow — see
 *   `EMPIRICAL_CREDS_SETUP.md` для setup.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = resolve(__dirname, '../apps/backend/src/domains/payment/_evidence')

// Verified 2026-04-29: only v3 exists. v4 not announced.
const YOOKASSA_BASE = 'https://api.yookassa.ru/v3'

interface YooKassaPaymentResponse {
	id?: string
	status?: 'pending' | 'waiting_for_capture' | 'succeeded' | 'canceled'
	paid?: boolean
	test?: boolean
	amount?: { value: string; currency: string }
	confirmation?: { type: string; confirmation_url?: string; return_url?: string }
	receipt_registration?: 'pending' | 'succeeded' | 'canceled'
	cancellation_details?: { party: string; reason: string }
	created_at?: string
	expires_at?: string
	metadata?: Record<string, string>
	[key: string]: unknown
}

function ensureEvidenceDir(): void {
	if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true })
}

function saveEvidence(filename: string, data: unknown): void {
	ensureEvidenceDir()
	const path = resolve(EVIDENCE_DIR, filename)
	writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
	console.log(`✅ Evidence saved: ${path}`)
}

function basicAuth(shopId: string, secretKey: string): string {
	return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`
}

function newIdempotenceKey(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function callYooKassa(
	endpoint: string,
	method: 'GET' | 'POST',
	authz: string,
	idempotenceKey: string | null,
	body: object | null,
): Promise<{ status: number; latencyMs: number; response: YooKassaPaymentResponse }> {
	const t0 = Date.now()
	const headers: Record<string, string> = {
		Authorization: authz,
		'Content-Type': 'application/json',
	}
	// CANONICAL spelling per yookassa.ru/developers/using-api/interaction-format.
	// NOTE: НЕ "Idempotency-Key" (Stripe spelling) — это распространённая ошибка.
	if (idempotenceKey !== null) headers['Idempotence-Key'] = idempotenceKey
	const res = await fetch(`${YOOKASSA_BASE}${endpoint}`, {
		method,
		headers,
		body: body !== null ? JSON.stringify(body) : null,
	})
	const latencyMs = Date.now() - t0
	const status = res.status
	const response = (await res.json().catch(() => ({}))) as YooKassaPaymentResponse
	return { status, latencyMs, response }
}

async function main(): Promise<void> {
	const shopId = process.env.YOOKASSA_TEST_SHOP_ID
	const secretKey = process.env.YOOKASSA_TEST_SECRET_KEY

	if (!shopId || !secretKey) {
		console.error('❌ Required env: YOOKASSA_TEST_SHOP_ID + YOOKASSA_TEST_SECRET_KEY')
		console.error('   Setup: ЛК ЮKassa → Test mode toggle → copy credentials to .env')
		console.error('   See scripts/EMPIRICAL_CREDS_SETUP.md for step-by-step.')
		process.exit(1)
	}

	const authz = basicAuth(shopId, secretKey)

	// ─── Test 1: GET /v3/me — verify auth + retrieve account info ──────
	console.log('🌐 [1/3] GET /v3/me — verify HTTP Basic auth + account context')
	const me = await callYooKassa('/me', 'GET', authz, null, null)
	console.log(`   HTTP ${me.status}, latency ${me.latencyMs}ms`)
	saveEvidence('real-yookassa-me.json', me)
	if (me.status !== 200) {
		console.error('❌ /v3/me failed — credentials wrong or shop disabled')
		process.exit(1)
	}

	// ─── Test 2: POST /v3/payments — minimal payment, no receipt ───────
	console.log('🌐 [2/3] POST /v3/payments — minimal payload (no receipt)')
	const minimalKey = newIdempotenceKey('verify-min')
	const minimal = await callYooKassa('/payments', 'POST', authz, minimalKey, {
		amount: { value: '100.00', currency: 'RUB' },
		capture: true,
		confirmation: {
			type: 'redirect',
			return_url: 'https://example.com/return',
		},
		description: 'Empirical verification — minimal payment',
		metadata: { script: 'verify-yookassa-empirical', purpose: 'shape-diff' },
	})
	console.log(`   HTTP ${minimal.status}, latency ${minimal.latencyMs}ms`)
	console.log(`   status=${minimal.response.status}, test=${minimal.response.test}`)
	saveEvidence('real-yookassa-payment-minimal.json', minimal)

	// Replay-safety: same key → identical response
	console.log('🌐 [2.5/3] Replay POST /v3/payments — same Idempotence-Key, expect cached')
	const replay = await callYooKassa('/payments', 'POST', authz, minimalKey, {
		amount: { value: '100.00', currency: 'RUB' },
		capture: true,
		confirmation: { type: 'redirect', return_url: 'https://example.com/return' },
		description: 'Empirical verification — minimal payment',
		metadata: { script: 'verify-yookassa-empirical', purpose: 'shape-diff' },
	})
	const replayMatches = replay.response.id === minimal.response.id
	console.log(`   Replay id-match: ${replayMatches ? '✅' : '⚠️'} (expected match per canon)`)

	// ─── Test 3: POST /v3/payments with 54-ФЗ receipt (vat_code=11) ────
	console.log('🌐 [3/3] POST /v3/payments — with 54-ФЗ receipt (vat_code=11 НДС 22% 2026)')
	const receiptKey = newIdempotenceKey('verify-receipt')
	const receipt = await callYooKassa('/payments', 'POST', authz, receiptKey, {
		amount: { value: '5000.00', currency: 'RUB' },
		capture: true,
		confirmation: { type: 'redirect', return_url: 'https://example.com/return' },
		description: 'Проживание тестового гостя',
		receipt: {
			customer: { email: 'test@example.com' },
			items: [
				{
					description: 'Проживание в номере (тестовая ночь)',
					quantity: '1.00',
					amount: { value: '5000.00', currency: 'RUB' },
					vat_code: 11, // 22% per 376-ФЗ from 2026-01-01
					payment_subject: 'service', // canonical for accommodation (not "lodging")
					payment_mode: 'full_payment',
					measure: 'day',
				},
			],
		},
		metadata: { script: 'verify-yookassa-empirical', purpose: 'receipt-shape' },
	})
	console.log(`   HTTP ${receipt.status}, latency ${receipt.latencyMs}ms`)
	console.log(`   status=${receipt.response.status}, receipt_registration=${receipt.response.receipt_registration}`)
	saveEvidence('real-yookassa-payment-receipt.json', receipt)

	// ─── Diff report ───────────────────────────────────────────────────
	console.log('\n=== Canon vs Empirical diff ===')
	const minimalResp = minimal.response

	// Status enum check
	const validStatuses = ['pending', 'waiting_for_capture', 'succeeded', 'canceled']
	if (minimalResp.status && !validStatuses.includes(minimalResp.status)) {
		console.log(`⚠️  status='${minimalResp.status}' NOT in canon enum [${validStatuses.join(', ')}]`)
	} else {
		console.log(`✅ status='${minimalResp.status}' matches canon enum`)
	}

	// test flag check
	if (minimalResp.test === true) {
		console.log('✅ test:true flag present (sandbox confirmed)')
	} else {
		console.log('⚠️  test flag NOT true — check shopId is actually a test shop')
	}

	// confirmation_url shape
	if (minimalResp.confirmation?.type === 'redirect' && minimalResp.confirmation.confirmation_url) {
		console.log(`✅ confirmation.confirmation_url present: ${minimalResp.confirmation.confirmation_url}`)
	} else {
		console.log('⚠️  confirmation.confirmation_url missing or wrong type')
	}

	// Idempotence-Key replay
	if (replayMatches) {
		console.log('✅ Idempotence-Key replay: same key → cached response (canonical)')
	} else {
		console.log('⚠️  Idempotence-Key replay returned DIFFERENT id — canon violation')
	}

	// 54-ФЗ receipt accepted
	const receiptResp = receipt.response
	if (receipt.status === 200 && receiptResp.id) {
		console.log('✅ 54-ФЗ receipt with vat_code=11 accepted by sandbox')
	} else {
		console.log(`⚠️  Receipt request failed (HTTP ${receipt.status}) — check vat_code support`)
	}

	console.log(`\n📁 Evidence: ${EVIDENCE_DIR}/real-yookassa-*.json`)
	console.log('📌 Next steps:')
	console.log('   1. Inspect _evidence files — verify all expected fields present')
	console.log('   2. Compare response shape vs project_yookassa_canon_corrections.md')
	console.log('   3. If new fields seen — extend our Zod types in payment domain')
	console.log('   4. Webhook empirical: see EMPIRICAL_CREDS_SETUP.md (ngrok/cloudflared step)')
	console.log('   5. Commit «empirical-verified vs YooKassa YYYY-MM-DD»')
}

main().catch((err) => {
	console.error('❌ Verification failed:', err)
	saveEvidence('real-yookassa-error.json', {
		message: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	})
	process.exit(1)
})
