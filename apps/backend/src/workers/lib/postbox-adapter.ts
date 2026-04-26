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

export interface SendEmailInput {
	from: string
	to: string
	subject: string
	html: string
	text: string
}

export type SendEmailResult =
	| { kind: 'sent'; messageId: string }
	| { kind: 'permanent'; reason: string }
	| { kind: 'transient'; reason: string }

export interface EmailAdapter {
	send(input: SendEmailInput): Promise<SendEmailResult>
}

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
 * Endpoint: `postbox.<region>.cloud.yandex.net` (region = `ru-central1`
 * for Сочи). Region matters only for SigV4 signing (any non-empty value
 * Postbox accepts; conventional value is `ru-central1`).
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

interface SendEmailCommandConstructor {
	new (input: {
		FromEmailAddress: string
		Destination: { ToAddresses: string[] }
		Content: {
			Simple: {
				Subject: { Data: string }
				Body: { Html: { Data: string }; Text: { Data: string } }
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
			const command = new this.SendEmailCommand({
				FromEmailAddress: input.from,
				Destination: { ToAddresses: [input.to] },
				Content: {
					Simple: {
						Subject: { Data: input.subject },
						Body: { Html: { Data: input.html }, Text: { Data: input.text } },
					},
				},
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
		const boundary = `boundary_${Date.now().toString(36)}`

		// Multipart/alternative: text + html. Mailpit renders both branches —
		// matches the dual-MIME shape we ship to Postbox in production.
		const message = [
			`From: ${input.from}`,
			`To: ${input.to}`,
			`Subject: =?UTF-8?B?${Buffer.from(input.subject).toString('base64')}?=`,
			`Date: ${date}`,
			`Message-ID: ${messageId}`,
			'MIME-Version: 1.0',
			`Content-Type: multipart/alternative; boundary="${boundary}"`,
			'',
			`--${boundary}`,
			'Content-Type: text/plain; charset=UTF-8',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(input.text)
				.toString('base64')
				.match(/.{1,76}/g)
				?.join('\r\n') ?? '',
			'',
			`--${boundary}`,
			'Content-Type: text/html; charset=UTF-8',
			'Content-Transfer-Encoding: base64',
			'',
			Buffer.from(input.html)
				.toString('base64')
				.match(/.{1,76}/g)
				?.join('\r\n') ?? '',
			'',
			`--${boundary}--`,
		].join('\r\n')

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
					step += 1
					if (step === 1) socket.write('EHLO sochi\r\n')
					else if (step === 2) socket.write(`MAIL FROM:<${input.from}>\r\n`)
					else if (step === 3) socket.write(`RCPT TO:<${input.to}>\r\n`)
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
}

interface FactoryLogger {
	info: (obj: object, msg?: string) => void
	warn: (obj: object, msg?: string) => void
}

/**
 * Pick the right adapter based on environment.
 *
 *   POSTBOX_ENABLED=true + creds → PostboxAdapter (Yandex Cloud production)
 *   POSTBOX_ENABLED=true + missing creds → log-only (StubAdapter) + warn
 *   POSTBOX_ENABLED=false + SMTP_HOST set → MailpitAdapter (local dev)
 *   neither → StubAdapter (CI / e2e where SMTP isn't available)
 *
 * Pattern from stankoff-v2; pre-launch verification is `dig TXT _domainkey.<domain>`
 * + DKIM/SPF/DMARC records on sender domain (set in infra-фаза, not here).
 */
export function createEmailAdapter(env: EmailAdapterEnv, log: FactoryLogger): EmailAdapter {
	if (env.POSTBOX_ENABLED) {
		if (!env.POSTBOX_ACCESS_KEY_ID || !env.POSTBOX_SECRET_ACCESS_KEY) {
			log.warn(
				{ POSTBOX_ENABLED: true },
				'POSTBOX_ENABLED=true but credentials missing — falling back to log-only StubAdapter',
			)
			return new StubAdapter()
		}
		const client = new SESv2Client({
			region: 'ru-central1',
			endpoint: env.POSTBOX_ENDPOINT,
			credentials: {
				accessKeyId: env.POSTBOX_ACCESS_KEY_ID,
				secretAccessKey: env.POSTBOX_SECRET_ACCESS_KEY,
			},
		})
		log.info({ endpoint: env.POSTBOX_ENDPOINT }, 'Email adapter: Yandex Cloud Postbox')
		return new PostboxAdapter(client, SendEmailCommand)
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
