/**
 * Round 14 (canon de-legacy + AI stack) — Yandex AI Studio HTTP client.
 *
 * Canon: `project_2026_grade_architecture_canon_2026_05_25.md` § AI stack —
 * was framed as «external blocker — multi-day API creds + GPU provisioning».
 * User trigger «есть Yandex AI Studio — в нём всё что нам нужно» rectified:
 * Yandex AI Studio = unified RU AI platform with OpenAI-compat REST endpoint,
 * no on-prem GPU required, API key auth.
 *
 * Note: official `yandex-ai-studio-sdk` is Python-only (verified GitHub May 2026).
 * Node/Bun integration uses REST API directly through native `fetch`.
 *
 * Endpoint canon (May 2026):
 *   - Foundation Models: `https://llm.api.cloud.yandex.net/foundationModels/v1/completion`
 *   - Auth: `Authorization: Api-Key <YC_API_KEY>` OR `Bearer <IAM_TOKEN>`
 *   - Required header: `x-folder-id: <YC_FOLDER_ID>`
 *
 * Models available (per Yandex AI Studio May 2026):
 *   - `yandexgpt-lite/latest` — fast, cheap
 *   - `yandexgpt/latest` — flagship «YandexGPT Pro»
 *   - `alice-ai-llm/latest` — Alice AI (chat-optimized)
 *   - `qwen-3/latest`, `deepseek-v3/latest`, `openai-oss-20b/latest`
 *
 * Configuration (env vars):
 *   - `YANDEX_AI_API_KEY`   — Yandex Cloud API key
 *   - `YANDEX_AI_FOLDER_ID` — Yandex Cloud folder ID
 *   - `YANDEX_AI_MODEL`     — model URI (default `yandexgpt-lite/latest`)
 *
 * Missing env → client returns `{ kind: 'not_configured' }`. Callers handle
 * gracefully (skeleton-mode response). When user provides credentials в
 * Lockbox / env, real generation активируется без code change.
 */

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
}

export type ChatCompletionResult =
	| {
			readonly kind: 'ok'
			readonly text: string
			readonly usage: { readonly inputTokens: number; readonly outputTokens: number }
	  }
	| { readonly kind: 'not_configured'; readonly reason: string }
	| { readonly kind: 'error'; readonly status: number; readonly message: string }

const DEFAULT_ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion'
const DEFAULT_MODEL = 'yandexgpt-lite/latest'

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): YandexAiStudioConfig {
	return {
		apiKey: env.YANDEX_AI_API_KEY,
		folderId: env.YANDEX_AI_FOLDER_ID,
		model: env.YANDEX_AI_MODEL ?? DEFAULT_MODEL,
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
	const endpoint = config.endpoint ?? DEFAULT_ENDPOINT
	const fetchFn = config.fetchImpl ?? globalThis.fetch
	const body = {
		modelUri: `gpt://${config.folderId}/${config.model}`,
		completionOptions: {
			stream: false,
			temperature: input.temperature ?? 0.3,
			maxTokens: String(input.maxTokens ?? 500),
		},
		messages: input.messages,
	}
	let res: Response
	try {
		res = await fetchFn(endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Api-Key ${config.apiKey}`,
				'Content-Type': 'application/json',
				'x-folder-id': config.folderId,
			},
			body: JSON.stringify(body),
		})
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return { kind: 'error', status: 0, message: `network: ${msg}` }
	}
	if (!res.ok) {
		const text = await res.text().catch(() => '')
		return { kind: 'error', status: res.status, message: text.slice(0, 300) }
	}
	const data = (await res.json()) as {
		result?: {
			alternatives?: ReadonlyArray<{ message?: { text?: string } }>
			usage?: { inputTextTokens?: string; completionTokens?: string }
		}
	}
	const text = data.result?.alternatives?.[0]?.message?.text ?? ''
	const inputTokens = Number(data.result?.usage?.inputTextTokens ?? 0)
	const outputTokens = Number(data.result?.usage?.completionTokens ?? 0)
	return { kind: 'ok', text, usage: { inputTokens, outputTokens } }
}
