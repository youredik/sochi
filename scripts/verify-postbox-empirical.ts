/**
 * Empirical verification script for Yandex Cloud Postbox SES v2 contract
 * vs our `apps/backend/src/workers/lib/postbox-adapter.ts` PostboxAdapter.
 *
 * Per `feedback_empirical_mock_verification.md`: «sandbox-reachable services
 * MUST be curl-verified before claiming adapter behaviour-faithful».
 *
 * ## What this script does
 *
 *   1. Initializes `@aws-sdk/client-sesv2` SESv2Client с Postbox endpoint.
 *   2. Sends ONE test email to a verified recipient (sandbox limit).
 *   3. Captures raw SDK response к
 *      `apps/backend/src/workers/_evidence/real-postbox-send.json`.
 *   4. Diffs against canon expectations:
 *      - response.MessageId present (success path)
 *      - $metadata.httpStatusCode = 200
 *      - endpoint URL без региона (canonical: `postbox.cloud.yandex.net`)
 *      - SigV4 region=`ru-central1`, service=`ses` (not `email`)
 *   5. Reports gaps + concrete fix recommendations.
 *
 * ## How to run
 *
 *   1. YC console → Postbox → создать SA с ролью `postbox.sender`.
 *   2. SA → API key → issue static access keys (key ID + secret).
 *   3. Sender domain — verify via DKIM CNAME OR TXT record (24h propagation).
 *   4. Recipient — must be verified в sandbox mode (use your own email).
 *   5. Add to .env:
 *
 *      POSTBOX_ACCESS_KEY_ID=YCAJ...
 *      POSTBOX_SECRET_ACCESS_KEY=YC...
 *      POSTBOX_VERIFIED_FROM=noreply@<your-verified-domain>
 *      POSTBOX_VERIFIED_TO=<your-personal-email>
 *
 *   6. Run:
 *
 *      node --env-file-if-exists=.env scripts/verify-postbox-empirical.ts
 *
 *   7. Check inbox + review _evidence/.
 *
 * ## Cost
 *
 *   Yandex Cloud Postbox: первые 10 000 emails/месяц бесплатно (sandbox).
 *   Single test email = 0₽.
 *
 * ## Bounce/Complaint event verification NOT covered
 *
 *   Bounce/complaint event push (Cloud Logging stream) — отдельная manual
 *   verification. Symptom: send to `bounce@simulator.amazonses.com` analog
 *   для AWS SES (Postbox equivalent — no source confirmed). Alternatively,
 *   send to invalid address like `nonexistent-12345@example.com` and watch
 *   Cloud Logging stream через console.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = resolve(__dirname, '../apps/backend/src/workers/_evidence')

// Canonical 2026 — verified live yandex.cloud/en/docs/postbox 2026-04-29.
// Single global host (NOT regional subdomain). Region appears only в SigV4
// signing string `aws:amz:ru-central1:ses`, NOT в URL.
const POSTBOX_ENDPOINT = 'https://postbox.cloud.yandex.net'

function ensureEvidenceDir(): void {
	if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true })
}

function saveEvidence(filename: string, data: unknown): void {
	ensureEvidenceDir()
	const path = resolve(EVIDENCE_DIR, filename)
	writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
	console.log(`✅ Evidence saved: ${path}`)
}

async function main(): Promise<void> {
	const accessKeyId = process.env.POSTBOX_ACCESS_KEY_ID
	const secretAccessKey = process.env.POSTBOX_SECRET_ACCESS_KEY
	const fromAddr = process.env.POSTBOX_VERIFIED_FROM
	const toAddr = process.env.POSTBOX_VERIFIED_TO

	if (!accessKeyId || !secretAccessKey || !fromAddr || !toAddr) {
		console.error('❌ Required env: POSTBOX_ACCESS_KEY_ID + POSTBOX_SECRET_ACCESS_KEY')
		console.error('                + POSTBOX_VERIFIED_FROM + POSTBOX_VERIFIED_TO')
		console.error('   Setup: see scripts/EMPIRICAL_CREDS_SETUP.md')
		process.exit(1)
	}

	// Match the canonical wiring used by createEmailAdapter() в production.
	const client = new SESv2Client({
		region: 'ru-central1',
		endpoint: POSTBOX_ENDPOINT,
		credentials: { accessKeyId, secretAccessKey },
	})

	const command = new SendEmailCommand({
		FromEmailAddress: fromAddr,
		Destination: { ToAddresses: [toAddr] },
		Content: {
			Simple: {
				Subject: { Data: '[Empirical Verify] Postbox SES v2 contract' },
				Body: {
					Text: {
						Data:
							'Если вы получили это письмо — наш PostboxAdapter контракт ' +
							'совместим с Yandex Cloud Postbox SES v2 на 2026-04-29. ' +
							'Это automated empirical verification, не маркетинг.',
					},
					Html: {
						Data:
							'<p>Если вы получили это письмо — наш PostboxAdapter контракт ' +
							'совместим с Yandex Cloud Postbox SES v2 на 2026-04-29.</p>' +
							'<p><em>Это automated empirical verification, не маркетинг.</em></p>',
					},
				},
			},
		},
	})

	console.log(`🌐 SendEmail through Postbox SES v2 endpoint=${POSTBOX_ENDPOINT}`)
	console.log(`   from=${fromAddr} to=${toAddr}`)
	const t0 = Date.now()
	try {
		const response = await client.send(command)
		const latencyMs = Date.now() - t0

		const httpStatus = response.$metadata.httpStatusCode
		const messageId = response.MessageId
		console.log(`   HTTP ${httpStatus}, latency ${latencyMs}ms`)
		console.log(`   MessageId: ${messageId}`)

		saveEvidence('real-postbox-send.json', {
			httpStatus,
			latencyMs,
			MessageId: messageId,
			$metadata: response.$metadata,
		})

		// ─── Diff report ─────────────────────────────────────────────────
		console.log('\n=== Canon vs Empirical diff ===')
		if (httpStatus === 200) {
			console.log('✅ HTTP 200 — endpoint reachable, auth + signing valid')
		} else {
			console.log(`⚠️  HTTP ${httpStatus} — non-200 ack from Postbox`)
		}
		if (messageId && messageId.length > 0) {
			console.log(`✅ MessageId returned (${messageId.length} chars)`)
		} else {
			console.log('⚠️  MessageId empty or missing — adapter classifyPostboxError treats as transient')
		}

		console.log(`\n📁 Evidence: ${EVIDENCE_DIR}/real-postbox-send.json`)
		console.log('📌 Next steps:')
		console.log('   1. Check inbox at', toAddr, '— verify email arrived')
		console.log('   2. Inspect raw email headers — verify DKIM-Signature is RSA+SHA256')
		console.log('   3. Verify SPF + DMARC alignment via mail-tester.com если есть желание')
		console.log('   4. Bounce/Complaint flow: send to invalid address + watch Cloud Logging')
		console.log('   5. If clean → commit «empirical-verified vs Postbox SES v2 YYYY-MM-DD»')
	} catch (err) {
		const latencyMs = Date.now() - t0
		const errName = err instanceof Error ? err.name : 'unknown'
		const errMsg = err instanceof Error ? err.message : String(err)
		const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
		console.error(`❌ SendEmail failed after ${latencyMs}ms: ${errName}: ${errMsg}`)
		if (meta?.httpStatusCode) console.error(`   HTTP ${meta.httpStatusCode}`)

		saveEvidence('real-postbox-error.json', {
			latencyMs,
			errorName: errName,
			errorMessage: errMsg,
			$metadata: meta,
			stack: err instanceof Error ? err.stack : undefined,
		})

		console.log('\n📌 Common causes:')
		console.log('   - MailFromDomainNotVerifiedException → DKIM CNAME не propagated yet (24h)')
		console.log('   - MessageRejected → recipient не в verified list (sandbox mode)')
		console.log('   - AccessDeniedException → SA missing role `postbox.sender`')
		console.log('   - InvalidParameterValueException → from/to address malformed')
		process.exit(1)
	}
}

main().catch((err) => {
	console.error('❌ Top-level failure:', err)
	process.exit(1)
})
