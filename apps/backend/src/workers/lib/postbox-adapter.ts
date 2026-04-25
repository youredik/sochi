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
