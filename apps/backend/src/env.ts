import { z } from 'zod'

/**
 * Environment variable schema. Validates on startup — fails fast with a clear error.
 * Never access process.env directly in the codebase; always import `env` from here.
 *
 * Exported (instead of file-private) so that `env.test.ts` can verify
 * transforms (e.g. APP_MODE_PERMITTED_MOCK_ADAPTERS comma-split) without
 * mutating real `process.env`.
 */
export const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	PORT: z.coerce.number().int().min(1).max(65535).default(8787),
	LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

	// PWA + WebAuthn host identity (M9.4 Risk #15 pre-condition).
	//
	// `HOST` — bare hostname WITHOUT protocol/port (WebAuthn `rpID` requirement
	// per W3C spec). Examples: `localhost` (dev), `app.sochi-horeca.ru` (prod).
	// Used by Better Auth passkey plugin для relying-party identity binding;
	// MUST match cookie domain. Mismatch silently fails passkey enroll/signin.
	//
	// `PUBLIC_BASE_URL` — full origin URL с protocol + port (passkey
	// `origin` parameter). Examples: `http://localhost:5273` (dev),
	// `https://app.sochi-horeca.ru` (prod). WebAuthn cross-checks request
	// origin header против этого value — must match exactly per protocol scheme.
	HOST: z.string().default('localhost'),
	PUBLIC_BASE_URL: z.string().url().default('http://localhost:5273'),

	// Sandbox / Production gate (M8.0 prep — see plans/local-complete-system-v2.md §6).
	//
	// `APP_MODE` is independent from `NODE_ENV`. Same prod-built artefact runs
	// in either mode; the difference is whether external-integration adapters
	// MUST be in 'live' mode at startup. This separation prevents the class of
	// bugs where "we built for production but forgot to flip a feature flag".
	//
	//   APP_MODE=sandbox    — default. Mocks/sandboxes are permitted.
	//                         Used in dev, CI, staging until cutover.
	//   APP_MODE=production — live integrations required.
	//                         Startup REFUSES if any registered adapter is
	//                         still mock/sandbox (unless whitelisted below).
	//
	// `APP_MODE_PERMITTED_MOCK_ADAPTERS` — comma-separated allow-list of
	// adapter names that may remain in mock/sandbox even in production. Use
	// VERY sparingly and document each entry in deploy notes; typical case is
	// ЕПГУ during the multi-week ОВМ МВД agreement onboarding.
	APP_MODE: z.enum(['sandbox', 'production']).default('sandbox'),
	APP_MODE_PERMITTED_MOCK_ADAPTERS: z
		.string()
		.default('')
		.transform((s) =>
			s
				.split(',')
				.map((v) => v.trim())
				.filter(Boolean),
		),

	// YDB
	YDB_CONNECTION_STRING: z.string().min(1),

	// Better Auth
	BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 chars'),
	BETTER_AUTH_URL: z.url(),
	BETTER_AUTH_TRUSTED_ORIGINS: z.string().default(''),

	// S3 / Object Storage
	S3_ENDPOINT: z.url(),
	S3_REGION: z.string().default('ru-central1'),
	S3_ACCESS_KEY_ID: z.string().min(1),
	S3_SECRET_ACCESS_KEY: z.string().min(1),
	S3_BUCKET: z.string().min(1),

	// Email transport — dual-mode (M7.fix.2):
	//   POSTBOX_ENABLED=true  → Yandex Cloud Postbox via SES-compat HTTPS API (production)
	//   POSTBOX_ENABLED=false → SMTP to Mailpit (local dev)
	//   Neither configured    → log-only (silent — useful in CI / e2e where
	//                           SMTP isn't available)
	POSTBOX_ENABLED: z.coerce.boolean().default(false),
	POSTBOX_ACCESS_KEY_ID: z.string().optional(),
	POSTBOX_SECRET_ACCESS_KEY: z.string().optional(),
	POSTBOX_ENDPOINT: z.string().default('https://postbox.cloud.yandex.net'),
	// Sender identity. Domain MUST be DKIM/SPF/DMARC-verified at Postbox before
	// production launch — see project_deferred_deploy_plan.md (infra-фаза).
	SMTP_HOST: z.string().default('localhost'),
	SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1125),
	EMAIL_FROM_ADDRESS: z.email(),
	EMAIL_FROM_NAME: z.string().default('HoReCa'),

	// Yandex SmartCaptcha server key (`ysc2_...`) for POST /validate.
	// Optional: when unset, captcha enforcement is disabled (dev / CI).
	// When set, the Better Auth `before` hook rejects sign-up / sign-in /
	// magic-link without a valid captchaToken in the request body.
	// Bootstrapped via `yc smartcaptcha captcha get-secret-key <id>` into
	// Yandex Lockbox after first Terraform apply. Per
	// `feedback_yandex_cloud_only.md` — Yandex Cloud captcha (not Cloudflare
	// Turnstile) for 152-ФЗ data localization.
	SMARTCAPTCHA_SERVER_KEY: z.string().optional(),

	// Demo deployment flag — when `true`, captcha-gate bypasses validation
	// EVEN IF `SMARTCAPTCHA_SERVER_KEY` is set. Per `[[demo_strategy]]`:
	// public hosted demo (e.g. demo.sochi.ru) runs friction-free for
	// prospects evaluating product. Frontend pairs via `VITE_DEMO_DEPLOYMENT
	// =true` — must be set consistently. Mismatch (frontend off, backend on
	// OR vice-versa) yields blanket 403 because forms cannot mint a token
	// AND the gate refuses non-tokened requests.
	DEMO_DEPLOYMENT: z.coerce.boolean().default(false),

	// DaData REST API token (`Token <…>` Authorization header).
	// Optional: unset / empty / whitespace-only → onboarding identity-lookup
	// falls back to `dadata.mock` (canonical Сочи demo set; demo tenants
	// continue to work без аккаунта). When set, real `suggestions.dadata.ru`
	// auto-fills ИНН → имя/адрес/налог.режим. Free tier 10k req/day suffices
	// для SMB volume. Tokens provisioned via dadata.ru account dashboard;
	// production seeded из Yandex Lockbox.
	DADATA_API_KEY: z.string().optional(),

	// M9.widget.6 / А4.3 — `clientCommitToken` HMAC sliding-window rotation
	// (D25). Both base64url-encoded ≥32-byte secrets. Production seeded из
	// Yandex Lockbox at boot; dev defaults are dev-only stubs (rejected при
	// APP_MODE=production via guard в embed.factory).
	//
	// Rotation flow (R2 F4 canon):
	//   1. Generate new secret → set `_PREVIOUS = $CURRENT_VALUE`,
	//      `_CURRENT = $NEW_VALUE`. Deploy.
	//   2. Wait `ttlSeconds` (300s default) for in-flight tokens to expire.
	//   3. Optional: clear `_PREVIOUS` to revoke any leaked tokens immediately.
	COMMIT_TOKEN_HMAC_CURRENT: z
		.string()
		.min(32, 'COMMIT_TOKEN_HMAC_CURRENT must be at least 32 chars')
		.default('dev-current-stub-secret-MUST-rotate-32+chars'),
	COMMIT_TOKEN_HMAC_PREVIOUS: z.string().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
	console.error('❌ Invalid environment variables:')
	console.error(z.prettifyError(parsed.error))
	process.exit(1)
}

export const env = parsed.data
