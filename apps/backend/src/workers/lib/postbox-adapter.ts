/**
 * Email send adapter — abstract interface + implementations.
 *
 * Two impls:
 *   - **StubAdapter**: dev / tests / pre-prod. Records sends in memory,
 *     returns synthesised messageId. Mailpit can be added later but stub
 *     is enough for V1 dev (`pnpm dev` runs without env config).
 *   - **PostboxAdapter**: production. Yandex Cloud Postbox via SES-compatible
 *     HTTPS API + AWS SigV4. Wraps `@aws-sdk/client-sesv2` with endpoint
 *     override per research synthesis 2026.
 *
 * **Error classification** (research §2 — anti-pattern §9 #2):
 *   - 2xx                       → `{ kind: 'sent', messageId }`
 *   - 4xx MessageRejected /
 *     InvalidParameterValue /
 *     MailFromDomainNotVerified /
 *     AccessDenied              → `{ kind: 'permanent', reason }` — no retry
 *   - 429 Throttling /
 *     5xx / network              → `{ kind: 'transient', reason }` — retry
 *
 * Worker translates `permanent` → `status='failed'` immediately, `transient`
 * → bump retryCount + nextAttemptAt with exponential backoff. Without this
 * classifier the dispatcher wastes Postbox quota retrying permanent errors
 * and blows reputation when Mail.ru bounces stick.
 */

/**
 * Email attachment payload (M9.widget.5 / A3.2.b).
 *
 * Used для .ics calendar invite + future PDF voucher attachments. Adapters
 * encode through their canonical send paths:
 *   - PostboxAdapter (SES v2): Content.Simple.Attachments[] с base64 RawContent
 *   - MailpitAdapter (SMTP): MIME multipart/mixed boundary
 *   - StubAdapter: stored verbatim для test assertions
 */
// EmailAttachment, SendEmailInput, SendEmailResult, EmailAdapter — moved
// to `./email-adapter.types.ts` to break the circular dep между
// `postbox-adapter.ts` (factory imports DemoInboxAdapter) и
// `demo-inbox-adapter.ts` (imports the contract). Re-exported here как
// `export *` для backward compatibility с existing callers.
export type {
	EmailAdapter,
	EmailAttachment,
	SendEmailInput,
	SendEmailResult,
} from './email-adapter.types.ts'

// Local-import shadow so PostboxAdapter / MailpitAdapter / StubAdapter
// type-annotate against the same identifiers без duplicating the public
// re-export.
import type { EmailAdapter, SendEmailInput, SendEmailResult } from './email-adapter.types.ts'

/* ----------------------------------------------------------------- StubAdapter */

/**
 * In-memory adapter for dev / tests. Each call records the send so tests
 * can assert dispatch happened with correct payload + recipients.
 *
 * Optionally configurable to fail on demand (set `nextResult` to simulate
 * transient/permanent errors in test scenarios — dispatcher retry path
 * coverage).
 */
export class StubAdapter implements EmailAdapter {
	readonly sent: SendEmailInput[] = []
	private nextResults: SendEmailResult[] = []

	async send(input: SendEmailInput): Promise<SendEmailResult> {
		this.sent.push(input)
		const overridden = this.nextResults.shift()
		if (overridden) return overridden
		return { kind: 'sent', messageId: `stub-${this.sent.length}` }
	}

	/** Queue a result to return for the NEXT send() call. FIFO. */
	queueResult(result: SendEmailResult): void {
		this.nextResults.push(result)
	}

	reset(): void {
		this.sent.length = 0
		this.nextResults.length = 0
	}
}

/* ----------------------------------------------------------------- PostboxAdapter */

/**
 * Yandex Cloud Postbox via SES-compatible HTTPS API.
 *
 * Auth: AWS-style Service Account static access key + SigV4. Avoids the
 * 12 h IAM-token TTL refresh dance — long-running worker stays connected.
 * SA needs `postbox.sender` role; key issued via `yc iam access-key create`.
 *
 * Endpoint: `postbox.cloud.yandex.net` (single global host — verified live
 * 2026-04-29 docs `yandex.cloud/en/docs/postbox/aws-compatible-api/api-ref`).
 * Region appears only in SigV4 signing string (`aws:amz:ru-central1:ses`),
 * NOT in URL host. Earlier `<region>.cloud.yandex.net` shape was a
 * misreading — Postbox accepts any non-empty SigV4 region value.
 *
 * Constructor accepts the AWS-SES-v2 client instance — caller wires
 * credentials + endpoint override. This keeps the worker test-friendly
 * (dependency injection) and the SDK upgrade path independent.
 *
 * Error mapping per AWS SES v2 status codes:
 *   - MessageRejected, MailFromDomainNotVerifiedException,
 *     InvalidParameterValueException, AccessDeniedException → permanent
 *   - ThrottlingException, SendingPausedException, 5xx, ECONNRESET → transient
 */
interface SesClientLike {
	send(command: unknown): Promise<{ MessageId?: string; $metadata?: { httpStatusCode?: number } }>
}

interface SesAttachment {
	FileName: string
	RawContent: Uint8Array
	ContentType: string
	ContentDisposition: 'ATTACHMENT'
	ContentTransferEncoding: 'BASE64'
}

interface SesMessageHeader {
	Name: string
	Value: string
}

interface SendEmailCommandConstructor {
	new (input: {
		FromEmailAddress: string
		Destination: { ToAddresses: string[] }
		/** RFC 5322 Reply-To. Recipients clicking «Reply» направляются сюда. */
		ReplyToAddresses?: string[]
		Content: {
			Simple: {
				Subject: { Data: string }
				Body: { Html: { Data: string }; Text: { Data: string } }
				Attachments?: SesAttachment[]
				/**
				 * Custom headers (AWS SES v2 2024+ canon). Used для:
				 *   - `List-Unsubscribe` (RFC 8058 one-click)
				 *   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
				 *   - other RFC 5322 headers
				 */
				Headers?: SesMessageHeader[]
			}
		}
	}): unknown
}

const PERMANENT_ERROR_NAMES = new Set([
	'MessageRejected',
	'MessageRejectedException',
	'MailFromDomainNotVerifiedException',
	'InvalidParameterValueException',
	'AccessDeniedException',
	'ConfigurationSetDoesNotExistException',
])

export class PostboxAdapter implements EmailAdapter {
	private readonly client: SesClientLike
	private readonly SendEmailCommand: SendEmailCommandConstructor

	constructor(client: SesClientLike, SendEmailCommand: SendEmailCommandConstructor) {
		this.client = client
		this.SendEmailCommand = SendEmailCommand
	}

	async send(input: SendEmailInput): Promise<SendEmailResult> {
		try {
			// SES v2 attachments shape: Content.Simple.Attachments[] с base64
			// RawContent. Per AWS docs (verified 2026-04 — `aws-sdk-js-v3
			// @aws-sdk/client-sesv2`).
			const sesAttachments: SesAttachment[] | undefined = input.attachments?.map((a) => ({
				FileName: a.filename,
				RawContent: Buffer.from(a.content, 'utf8'),
				ContentType: a.contentType,
				ContentDisposition: 'ATTACHMENT' as const,
				ContentTransferEncoding: 'BASE64' as const,
			}))
			const simple: {
				Subject: { Data: string }
				Body: { Html: { Data: string }; Text: { Data: string } }
				Attachments?: SesAttachment[]
				Headers?: SesMessageHeader[]
			} = {
				Subject: { Data: input.subject },
				Body: { Html: { Data: input.html }, Text: { Data: input.text } },
			}
			if (sesAttachments && sesAttachments.length > 0) {
				simple.Attachments = sesAttachments
			}
			// Custom RFC 5322 headers (List-Unsubscribe + RFC 8058 one-click).
			// SES v2 Simple.Headers — array of {Name, Value}. Postbox passthrough
			// per AWS SES v2 compat docs (verified 2026-05-22).
			const headers: SesMessageHeader[] = []
			if (input.listUnsubscribe) {
				headers.push({ Name: 'List-Unsubscribe', Value: input.listUnsubscribe })
				// RFC 8058 — declares one-click POST support. Gmail/Yahoo 2024+
				// требуют этот pair с List-Unsubscribe для bulk senders.
				headers.push({ Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' })
			}
			if (headers.length > 0) simple.Headers = headers

			const command = new this.SendEmailCommand({
				FromEmailAddress: input.from,
				Destination: { ToAddresses: [input.to] },
				...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
				Content: { Simple: simple },
			})
			const response = await this.client.send(command)
			if (response.MessageId) return { kind: 'sent', messageId: response.MessageId }
			// 200 without MessageId is anomalous — treat as transient (retry-safe).
			return { kind: 'transient', reason: 'Postbox 2xx without MessageId' }
		} catch (err) {
			return classifyPostboxError(err)
		}
	}
}

/**
 * Classify a thrown error from `@aws-sdk/client-sesv2` SendEmailCommand
 * into the dispatcher's permanent/transient buckets. Exported для unit-tests.
 */
export function classifyPostboxError(err: unknown): SendEmailResult {
	if (err instanceof Error) {
		const name = err.name
		if (PERMANENT_ERROR_NAMES.has(name)) return { kind: 'permanent', reason: name }
		// AWS SDK throws { $metadata: { httpStatusCode } } in some cases.
		const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
		const code = meta?.httpStatusCode
		if (typeof code === 'number') {
			if (code >= 400 && code < 500 && code !== 429) {
				return { kind: 'permanent', reason: `HTTP ${code}: ${name}` }
			}
		}
		return { kind: 'transient', reason: `${name}: ${err.message}` }
	}
	return { kind: 'transient', reason: 'unknown error' }
}

/* ----------------------------------------------------------------- MailpitAdapter */

import * as net from 'node:net'
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { DemoInboxAdapter } from './demo-inbox-adapter.ts'

/**
 * Extract the bare addr-spec from an RFC 5322 mailbox string for use in the
 * SMTP envelope (`MAIL FROM:<…>` / `RCPT TO:<…>` per RFC 5321 §3.3 / §4.1.2).
 *
 * The envelope reverse/forward-path takes ONLY the address — display names
 * belong in the `From:` / `To:` MIME headers, not in the SMTP command. Mailpit
 * and stricter MTAs reject `MAIL FROM:<"Name" <addr>>` with `501 Syntax error`.
 *
 *   '"HoReCa" <noreply@x.local>'  → 'noreply@x.local'
 *   'HoReCa <noreply@x.local>'    → 'noreply@x.local'
 *   '<noreply@x.local>'           → 'noreply@x.local'
 *   'noreply@x.local'             → 'noreply@x.local'
 *   '  bare@x  '                  → 'bare@x'
 *
 * `lastIndexOf` (not the first `<`) tolerates display names that contain
 * angle brackets like `'"Mr. <Cool>" <x@y>'`. Empty input or `<>` returns
 * `''` — caller treats this as the RFC 5321 null reverse-path (legal for
 * bounces; we never emit it in product code).
 */
export function extractEnvelopeAddress(mailbox: string): string {
	const trimmed = mailbox.trim()
	const lastLt = trimmed.lastIndexOf('<')
	const lastGt = trimmed.lastIndexOf('>')
	if (lastLt !== -1 && lastGt > lastLt) {
		return trimmed.slice(lastLt + 1, lastGt).trim()
	}
	return trimmed
}

/**
 * Process-singleton DemoInboxAdapter — the email factory and the
 * `/api/v1/public/demo/inbox` route MUST share the SAME instance so captures
 * from `EmailAdapter.send()` are visible к the polling route. Lazy-init на
 * first `createEmailAdapter` call с `DEMO_DEPLOYMENT=true` OR на first
 * `getDemoInboxIfActive()` (route handler).
 */
let demoInboxSingleton: DemoInboxAdapter | null = null

function getOrCreateDemoInbox(downstream?: EmailAdapter): DemoInboxAdapter {
	if (!demoInboxSingleton) {
		demoInboxSingleton = new DemoInboxAdapter(downstream ? { downstream } : {})
	}
	return demoInboxSingleton
}

/**
 * Module-level accessor для the demo inbox singleton. Used by the public
 * route handler в `apps/backend/src/domains/demo/inbox.routes.ts`. Returns
 * `null` when `createEmailAdapter` has not yet routed к the demo path —
 * the route handler treats this as «inbox empty» (200 + null), не a 500.
 */
export function getDemoInboxIfActive(): DemoInboxAdapter | null {
	return demoInboxSingleton
}

/** Test-only reset hook — `__resetForTesting()` pattern per bun-test canons. */
export function __resetDemoInboxForTesting(): void {
	demoInboxSingleton = null
}

/**
 * Plain-SMTP adapter for local dev — speaks raw SMTP via `node:net`. Mailpit
 * accepts everything (no TLS, no auth) and surfaces captured emails at the
 * Web UI on `:8125` for visual inspection during development.
 *
 * Zero external deps — keeps install footprint small (no nodemailer pull-in).
 * Pattern lifted directly from stankoff-v2 `services/email/email.ts`
 * (verified production-grade 2026 reference).
 *
 * Errors: SMTP server returning 4xx/5xx OR socket timeout → 'transient'
 * (Mailpit lives in docker; restart heals). Connection-refused (Mailpit
 * not running) → 'transient' too — operator should `docker compose up
 * mailpit` and the dispatcher's exp-backoff catches up.
 */
export class MailpitAdapter implements EmailAdapter {
	private readonly host: string
	private readonly port: number

	constructor(host: string, port: number) {
		this.host = host
		this.port = port
	}

	async send(input: SendEmailInput): Promise<SendEmailResult> {
		const date = new Date().toUTCString()
		const messageId = `<${Date.now()}.${crypto.randomUUID()}@sochi.local>`
		const altBoundary = `alt_${Date.now().toString(36)}`
		const mixedBoundary = `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

		// SMTP envelope wants bare addr-spec; display names live only in the
		// MIME `From:` / `To:` headers below. See `extractEnvelopeAddress`.
		const envelopeFrom = extractEnvelopeAddress(input.from)
		const envelopeTo = extractEnvelopeAddress(input.to)

		const hasAttachments = input.attachments && input.attachments.length > 0

		const altPart = [
			`Content-Type: multipart/alternative; boundary="${altBoundary}"`,
			'',
			`--${altBoundary}`,
			'Content-Type: text/plain; charset=UTF-8',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(input.text)
				.toString('base64')
				.match(/.{1,76}/g)
				?.join('\r\n') ?? '',
			'',
			`--${altBoundary}`,
			'Content-Type: text/html; charset=UTF-8',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(input.html)
				.toString('base64')
				.match(/.{1,76}/g)
				?.join('\r\n') ?? '',
			'',
			`--${altBoundary}--`,
		].join('\r\n')

		// MIME multipart/mixed когда есть attachments — text/html alternative
		// remains nested inside multipart/alternative subtree per RFC 2046.
		const headers = [
			`From: ${input.from}`,
			`To: ${input.to}`,
			`Subject: =?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=`,
			`Date: ${date}`,
			`Message-ID: ${messageId}`,
			'MIME-Version: 1.0',
		]

		const message = hasAttachments
			? [
					...headers,
					`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
					'',
					`--${mixedBoundary}`,
					altPart,
					...(input.attachments ?? []).flatMap((a) => [
						`--${mixedBoundary}`,
						`Content-Type: ${a.contentType}`,
						`Content-Disposition: attachment; filename="${a.filename}"`,
						'Content-Transfer-Encoding: base64',
						'',
						Buffer.from(a.content, 'utf8')
							.toString('base64')
							.match(/.{1,76}/g)
							?.join('\r\n') ?? '',
						'',
					]),
					`--${mixedBoundary}--`,
				].join('\r\n')
			: [...headers, altPart].join('\r\n')

		return new Promise<SendEmailResult>((resolve) => {
			const socket = net.createConnection(this.port, this.host)
			let step = 0
			let buffer = ''

			socket.setEncoding('utf8')
			socket.setTimeout(10_000)

			socket.on('data', (data: string) => {
				buffer += data
				if (!buffer.includes('\r\n')) return
				const lines = buffer.split('\r\n')
				buffer = lines.pop() ?? ''

				for (const line of lines) {
					const code = Number.parseInt(line.slice(0, 3), 10)
					if (code >= 400) {
						socket.destroy()
						resolve({ kind: 'transient', reason: `SMTP ${line}` })
						return
					}
					// RFC 5321 §4.2.1 — multi-line replies use `-` between the code
					// and the text on all but the LAST line (which uses space). The
					// state machine must advance ONCE per command response, not once
					// per line; otherwise a multi-line EHLO answer (which Mailpit /
					// Postfix / Postbox all emit: 250-greets / 250-SIZE / 250-AUTH /
					// 250-…/ 250 SMTPUTF8) fast-forwards the cursor through every
					// SMTP step in a single data event, blasting commands out of
					// order and resolving as «sent» before the server has even
					// received MAIL FROM. That race silently dropped magic-link
					// emails in dev: BA's `sendMagicLink` resolved status:true while
					// Mailpit had nothing in its inbox.
					if (line.length > 3 && line[3] === '-') continue
					step += 1
					if (step === 1) socket.write('EHLO sochi\r\n')
					else if (step === 2) socket.write(`MAIL FROM:<${envelopeFrom}>\r\n`)
					else if (step === 3) socket.write(`RCPT TO:<${envelopeTo}>\r\n`)
					else if (step === 4) socket.write('DATA\r\n')
					else if (step === 5) socket.write(`${message}\r\n.\r\n`)
					else if (step === 6) {
						socket.write('QUIT\r\n')
						resolve({ kind: 'sent', messageId })
					}
				}
			})

			socket.on('error', () => {
				resolve({ kind: 'transient', reason: 'SMTP connection failed (Mailpit down?)' })
			})
			socket.on('timeout', () => {
				socket.destroy()
				resolve({ kind: 'transient', reason: 'SMTP connection timeout' })
			})
		})
	}
}

/* ----------------------------------------------------------------- factory */

interface EmailAdapterEnv {
	POSTBOX_ENABLED: boolean
	POSTBOX_ACCESS_KEY_ID?: string | undefined
	POSTBOX_SECRET_ACCESS_KEY?: string | undefined
	POSTBOX_ENDPOINT: string
	SMTP_HOST: string
	SMTP_PORT: number
	/**
	 * Demo deployment flag — when `true`, factory returns a `DemoInboxAdapter`
	 * (capture-only, in-process). Paired with `VITE_DEMO_DEPLOYMENT=true` on
	 * the frontend per `[[demo_strategy]]`.
	 */
	DEMO_DEPLOYMENT?: boolean
}

interface FactoryLogger {
	info: (obj: object, msg?: string) => void
	warn: (obj: object, msg?: string) => void
}

/**
 * Pick the right adapter based on environment.
 *
 *   DEMO_DEPLOYMENT=true → DemoInboxAdapter (capture-only, public-hosted demo
 *                          per `[[demo_strategy]]` — short-circuits BEFORE
 *                          Postbox/Mailpit so prospect emails are never
 *                          actually transmitted, only surfaced inline in
 *                          frontend DemoInboxPanel)
 *   POSTBOX_ENABLED=true + creds → PostboxAdapter (Yandex Cloud production)
 *   POSTBOX_ENABLED=true + missing creds → log-only (StubAdapter) + warn
 *   POSTBOX_ENABLED=false + SMTP_HOST set → MailpitAdapter (local dev)
 *   neither → StubAdapter (CI / e2e where SMTP isn't available)
 *
 * Pattern from stankoff-v2; pre-launch verification is `dig TXT _domainkey.<domain>`
 * + DKIM/SPF/DMARC records on sender domain (set in infra-фаза, not here).
 */
export function createEmailAdapter(env: EmailAdapterEnv, log: FactoryLogger): EmailAdapter {
	// Build Postbox client если creds present — может wrap demo OR standalone.
	const postbox = buildPostboxIfReady(env, log)

	if (env.DEMO_DEPLOYMENT) {
		// **DUAL-MODE 2026-05-22 canon**: DemoInbox captures (UI panel) +
		// Postbox real send (если creds present). Prospect видит link в panel,
		// real users получают email на свой inbox. Без Postbox creds —
		// capture-only fallback (старый behavior).
		const downstream = postbox
		log.info(
			{ dualWrite: downstream !== undefined },
			downstream !== undefined
				? 'Email adapter: DemoInbox (capture + UI panel) + Postbox (real send)'
				: 'Email adapter: DemoInbox (capture-only, no Postbox creds)',
		)
		return getOrCreateDemoInbox(downstream)
	}
	if (env.POSTBOX_ENABLED) {
		if (postbox === undefined) {
			log.warn(
				{ POSTBOX_ENABLED: true },
				'POSTBOX_ENABLED=true but credentials missing — falling back to log-only StubAdapter',
			)
			return new StubAdapter()
		}
		log.info({ endpoint: env.POSTBOX_ENDPOINT }, 'Email adapter: Yandex Cloud Postbox')
		return postbox
	}

	if (env.SMTP_HOST && env.SMTP_PORT) {
		log.info(
			{ host: env.SMTP_HOST, port: env.SMTP_PORT },
			'Email adapter: SMTP (Mailpit) for local dev',
		)
		return new MailpitAdapter(env.SMTP_HOST, env.SMTP_PORT)
	}

	log.info({}, 'Email adapter: StubAdapter (log-only — no transport configured)')
	return new StubAdapter()
}

/**
 * Build PostboxAdapter если environment fully configured (POSTBOX_ENABLED=true
 * + access/secret keys). Returns `undefined` если any prereq missing.
 * Caller decides what к do с undefined (wrap demo, fall к stub, etc.).
 */
function buildPostboxIfReady(
	env: EmailAdapterEnv,
	_log: FactoryLogger,
): PostboxAdapter | undefined {
	if (!env.POSTBOX_ENABLED) return undefined
	if (!env.POSTBOX_ACCESS_KEY_ID || !env.POSTBOX_SECRET_ACCESS_KEY) return undefined
	const client = new SESv2Client({
		region: 'ru-central1',
		endpoint: env.POSTBOX_ENDPOINT,
		credentials: {
			accessKeyId: env.POSTBOX_ACCESS_KEY_ID,
			secretAccessKey: env.POSTBOX_SECRET_ACCESS_KEY,
		},
	})
	return new PostboxAdapter(client, SendEmailCommand)
}
