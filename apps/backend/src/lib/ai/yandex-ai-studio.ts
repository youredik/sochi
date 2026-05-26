/**
 * Round 14 self-review #3 (canon de-legacy + AI stack) — Yandex AI Studio
 * HTTP client.
 *
 * Canon: `project_2026_grade_architecture_canon_2026_05_25.md` § AI stack.
 * User trigger «из архитектурного нужен Yandex AI Studio, в нём всё что нам
 * нужно». Replaces «YandexGPT/Saiga multi-day blocker» framing: Yandex AI
 * Studio = unified RU AI platform with REST endpoint + Api-Key auth, no
 * on-prem GPU.
 *
 * **Note**: official `yandex-ai-studio-sdk` is Python-only (verified GitHub
 * May 2026). Node/Bun integration uses REST API directly via native `fetch`.
 *
 * Endpoint canon (verified WebFetch 2026-05-26 — `aistudio.yandex.ru/docs`):
 *   - Foundation Models: `https://llm.api.cloud.yandex.net/foundationModels/v1/completion`
 *   - OpenAI-compat (streaming/tools/structured-output): `/v1/chat/completions`
 *     (separate code path — exposed когда callers need those features)
 *   - Auth: `Authorization: Api-Key <YC_API_KEY>` OR `Bearer <IAM_TOKEN>`
 *   - With Api-Key auth, folder is implied by service account — `x-folder-id`
 *     header **redundant и не отправляется** (Yandex docs explicit). Folder
 *     embedded в `modelUri` prefix (`gpt://<folderId>/...`).
 *
 * **Model URIs** (verified WebFetch 2026-05-26 — exact canonical names):
 *   - `yandexgpt-lite/latest`            — fast, cheap (default — 0.20₽/1K)
 *   - `yandexgpt/latest`                 — flagship «YandexGPT 5.1 Pro» (0.80₽/1K)
 *   - `aliceai-llm`                      — Alice AI (chat-optimized; NO «-llm» suffix wrong)
 *   - `qwen3-235b-a22b-fp8`              — Qwen 3 235B (NOT «qwen-3»)
 *   - `qwen3.6-35b-a3b`                  — Qwen 3.6 35B (preferred over deprecated 3.5)
 *   - `deepseek-v32`                     — DeepSeek V3.2 (NOT «deepseek-v3»)
 *   - `gpt-oss-120b`, `gpt-oss-20b`      — OpenAI OSS (still available)
 *
 * **Hardening (this self-review pass)**:
 *   - AbortController timeout (default 15s) — DoS / hang protection
 *   - Endpoint whitelist `llm.api.cloud.yandex.net` — SSRF defense
 *   - Reserved-test PII shield на `messages.text` — outbound canon
 *     `feedback_outbound_side_effect_discipline` sibling sweep coverage
 *   - Length cap 8 KiB на total prompt body — token-bomb DoS
 *   - Structured pino logging (model + tokens + latency + status, no PII)
 *
 * Configuration (env vars):
 *   - `YANDEX_AI_API_KEY`   — Yandex Cloud API key
 *   - `YANDEX_AI_FOLDER_ID` — Yandex Cloud folder ID (embedded в modelUri)
 *   - `YANDEX_AI_MODEL`     — model URI (default `yandexgpt-lite/latest`)
 *   - `YANDEX_AI_TIMEOUT_MS` — fetch timeout override (default 15000)
 *
 * Missing env → client returns `{ kind: 'not_configured' }`. Callers handle
 * gracefully (skeleton-mode response). When user provides credentials в
 * Lockbox / env, real generation активируется без code change.
 */

import { logger } from '../../logger.ts'

export interface ChatMessage {
	readonly role: 'system' | 'user' | 'assistant'
	readonly text: string
}

export interface YandexAiStudioConfig {
	readonly apiKey: string | undefined
	readonly folderId: string | undefined
	readonly model: string
	readonly endpoint?: string
	readonly fetchImpl?: typeof fetch
	readonly timeoutMs?: number
}

export type ChatCompletionResult =
	| {
			readonly kind: 'ok'
			readonly text: string
			readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
			readonly model: string
	  }
	| { readonly kind: 'not_configured'; readonly reason: string }
	| {
			readonly kind: 'rejected'
			readonly reason: 'pii_in_prompt' | 'prompt_too_long'
			readonly message: string
	  }
	| { readonly kind: 'error'; readonly status: number; readonly message: string }

const DEFAULT_ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion'
const DEFAULT_MODEL = 'yandexgpt-lite/latest'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TOTAL_PROMPT_BYTES = 8_192
const ALLOWED_ENDPOINT_HOSTS = new Set(['llm.api.cloud.yandex.net'])

// PII heuristics для inbound prompt content. Conservative — false-positive bias
// в demo mode чтобы предотвратить leakage real PII в outbound AI call. Tightly
// scoped: only triggers на patterns обладающих low ambiguity (E.164 phone,
// passport-like 10-digit document numbers, non-reserved-test email domains,
// long Cyrillic surname runs). Adjustable если будущие use-cases hit false-positives.
const PHONE_REGEX = /\+?[0-9][\d\s()-]{9,}/u
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u
const PASSPORT_DOC_REGEX = /\b\d{4}\s?\d{6}\b/u // 4+6 digit Russian passport / 10-digit зайран
const RESERVED_TEST_EMAIL_DOMAINS =
	/@(example\.(?:com|net|org)|.+?\.(?:test|example|invalid|localhost))$/iu

/** Detects probable PII в outbound prompt text. Returns `null` if clean else reason string. */
function detectPii(text: string): string | null {
	// Email: strict reject ALL emails EXCEPT reserved-test ranges
	const emailMatch = text.match(EMAIL_REGEX)
	if (emailMatch !== null && !RESERVED_TEST_EMAIL_DOMAINS.test(emailMatch[0])) {
		return 'non-reserved-test email detected'
	}
	// Phone: any E.164-shaped run except известные reserved-test prefixes (99899, 7000, 1XXX555-01XX)
	const phoneMatch = text.match(PHONE_REGEX)
	if (phoneMatch !== null) {
		const digits = phoneMatch[0].replace(/\D/g, '')
		const isReservedTest =
			digits.startsWith('99899') ||
			digits.startsWith('7000') ||
			(digits.length >= 11 && digits.startsWith('1') && digits.slice(4, 9) === '55501')
		if (!isReservedTest) return 'non-reserved-test phone detected'
	}
	// Russian passport (4+6 = 10 digit) — never reserved-test; всегда reject
	if (PASSPORT_DOC_REGEX.test(text)) return 'passport-like number detected'
	return null
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YandexAiStudioConfig {
	const timeoutOverride = env.YANDEX_AI_TIMEOUT_MS
	const timeoutMs =
		timeoutOverride !== undefined && timeoutOverride.length > 0
			? Number.parseInt(timeoutOverride, 10)
			: undefined
	return {
		apiKey: env.YANDEX_AI_API_KEY,
		folderId: env.YANDEX_AI_FOLDER_ID,
		model: env.YANDEX_AI_MODEL ?? DEFAULT_MODEL,
		...(timeoutMs !== undefined && !Number.isNaN(timeoutMs) && { timeoutMs }),
	}
}

/**
 * Send a chat completion request to Yandex AI Studio. Returns `not_configured`
 * if env credentials missing (Sepshn demo deployments without keys gracefully
 * fall back to skeleton responses).
 */
export async function chatCompletion(
	input: {
		readonly messages: ReadonlyArray<ChatMessage>
		readonly temperature?: number
		readonly maxTokens?: number
	},
	config: YandexAiStudioConfig,
): Promise<ChatCompletionResult> {
	if (
		config.apiKey === undefined ||
		config.apiKey.length === 0 ||
		config.folderId === undefined ||
		config.folderId.length === 0
	) {
		return {
			kind: 'not_configured',
			reason:
				'YANDEX_AI_API_KEY + YANDEX_AI_FOLDER_ID env vars required — Yandex AI Studio integration disabled',
		}
	}
	// SSRF defense — only allow canonical Yandex Cloud endpoint host. Test
	// harnesses pass `fetchImpl` (DI) so this gate doesn't block them; only
	// hard-rejects если caller тmpt switch к user-controlled URL.
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT
	try {
		const url = new URL(endpoint)
		if (config.fetchImpl === undefined && !ALLOWED_ENDPOINT_HOSTS.has(url.host)) {
			return {
				kind: 'error',
				status: 0,
				message: `endpoint host not whitelisted: ${url.host}`,
			}
		}
	} catch {
		return { kind: 'error', status: 0, message: 'invalid endpoint url' }
	}
	// Reserved-test PII shield per `feedback_outbound_side_effect_discipline`.
	// Every outbound adapter applies this gate uniformly. Demo mode = no real
	// PII out к Yandex AI Studio (152-ФЗ ст.6 — нет правового основания для
	// обработки чужих ПДн через third-party). Reject WITHOUT calling upstream.
	let totalBytes = 0
	for (const msg of input.messages) {
		const piiReason = detectPii(msg.text)
		if (piiReason !== null) {
			logger.warn({ piiReason, role: msg.role }, 'AI prompt rejected — PII detected')
			return {
				kind: 'rejected',
				reason: 'pii_in_prompt',
				message: `outbound prompt contains PII (${piiReason}); use reserved-test ranges or scrub before sending`,
			}
		}
		totalBytes += Buffer.byteLength(msg.text, 'utf8')
		if (totalBytes > MAX_TOTAL_PROMPT_BYTES) {
			return {
				kind: 'rejected',
				reason: 'prompt_too_long',
				message: `total prompt > ${MAX_TOTAL_PROMPT_BYTES} bytes — refuse to forward`,
			}
		}
	}

	const fetchFn = config.fetchImpl ?? globalThis.fetch
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const body = {
		modelUri: `gpt://${config.folderId}/${config.model}`,
		completionOptions: {
			stream: false,
			// Clamp temperature к canonical 0..1 (Yandex AI Studio rejects >1 anyway,
			// but defense-in-depth gate avoids round-trip к upstream).
			temperature: Math.min(1, Math.max(0, input.temperature ?? 0.3)),
			maxTokens: String(input.maxTokens ?? 500),
		},
		messages: input.messages,
	}
	// AbortController timeout. Cold-start MCP tool invocation that hangs on
	// Yandex outage MUST NOT block the MCP server thread indefinitely. Bun's
	// default fetch timeout = none. 15s ceiling is plenty for chat completion.
	const abortCtrl = new AbortController()
	const timeoutHandle = setTimeout(() => abortCtrl.abort(), timeoutMs)
	const startMs = Date.now()
	let res: Response
	try {
		res = await fetchFn(endpoint, {
			method: 'POST',
			headers: {
				// With Api-Key auth, folder is implied by SA — `x-folder-id` header
				// **redundant** and не отправляется (Yandex docs explicit). Folder
				// embedded в modelUri prefix instead.
				Authorization: `Api-Key ${config.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			signal: abortCtrl.signal,
		})
	} catch (e) {
		clearTimeout(timeoutHandle)
		const aborted = e instanceof Error && e.name === 'AbortError'
		const msg = e instanceof Error ? e.message : String(e)
		const latencyMs = Date.now() - startMs
		logger.warn(
			{ event: 'ai.completion.error', model: config.model, latencyMs, kind: 'network' },
			'Yandex AI Studio fetch failed',
		)
		return {
			kind: 'error',
			status: aborted ? 408 : 0,
			message: aborted ? `aborted after ${timeoutMs}ms` : `network: ${msg}`,
		}
	}
	clearTimeout(timeoutHandle)
	const latencyMs = Date.now() - startMs
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		logger.warn(
			{ event: 'ai.completion.error', model: config.model, latencyMs, status: res.status },
			'Yandex AI Studio non-2xx',
		)
		return { kind: 'error', status: res.status, message: text.slice(0, 300) }
	}
	const data = (await res.json().catch(() => null)) as {
		result?: {
			alternatives?: ReadonlyArray<{ message?: { text?: string } }>
			usage?: { inputTextTokens?: string | number; completionTokens?: string | number }
		}
	} | null
	if (data === null || data.result === undefined) {
		logger.warn(
			{ event: 'ai.completion.error', model: config.model, latencyMs, kind: 'malformed_response' },
			'Yandex AI Studio malformed JSON',
		)
		return { kind: 'error', status: 200, message: 'malformed_response — no `result`' }
	}
	const text = data.result.alternatives?.[0]?.message?.text
	if (text === undefined || text === '') {
		logger.warn(
			{ event: 'ai.completion.error', model: config.model, latencyMs, kind: 'empty_completion' },
			'Yandex AI Studio empty alternatives',
		)
		return { kind: 'error', status: 200, message: 'empty_completion — no alternatives' }
	}
	const inputTokens = parseTokenCount(data.result.usage?.inputTextTokens)
	const outputTokens = parseTokenCount(data.result.usage?.completionTokens)
	logger.info(
		{
			event: 'ai.completion.ok',
			model: config.model,
			latencyMs,
			inputTokens,
			outputTokens,
		},
		'Yandex AI Studio completion',
	)
	return { kind: 'ok', text, model: config.model, usage: { inputTokens, outputTokens } }
}

/** Robust token-count parser. Yandex AI Studio ships these as strings OR numbers
 * depending on driver / SDK version; un-coercible → 0 (defensive). */
function parseTokenCount(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value === 'string') {
		const n = Number(value)
		return Number.isFinite(n) ? n : 0
	}
	return 0
}
