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
	PORT: z.coerce.number().int().min(1).max(65535).default(3001),
	LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

	// PWA + WebAuthn host identity (M9.4 Risk #15 pre-condition).
	//
	// `HOST` — bare hostname WITHOUT protocol/port (WebAuthn `rpID` requirement
	// per W3C spec). Examples: `localhost` (dev), `app.sochi-horeca.ru` (prod).
	// Used by Better Auth passkey plugin для relying-party identity binding;
	// MUST match cookie domain. Mismatch silently fails passkey enroll/signin.
	//
	// `PUBLIC_BASE_URL` — full origin URL с protocol + port (passkey
	// `origin` parameter). Examples: `http://localhost:5173` (dev),
	// `https://app.sochi-horeca.ru` (prod). WebAuthn cross-checks request
	// origin header против этого value — must match exactly per protocol scheme.
	HOST: z.string().default('localhost'),
	PUBLIC_BASE_URL: z.string().url().default('http://localhost:5173'),

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
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
	console.error('❌ Invalid environment variables:')
	console.error(z.prettifyError(parsed.error))
	process.exit(1)
}

export const env = parsed.data
