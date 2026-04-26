import { z } from 'zod'

/**
 * Environment variable schema. Validates on startup — fails fast with a clear error.
 * Never access process.env directly in the codebase; always import `env` from here.
 */
const envSchema = z.object({
	NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
	PORT: z.coerce.number().int().min(1).max(65535).default(3000),
	LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

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
