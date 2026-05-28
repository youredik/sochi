import { z } from 'zod'

/**
 * Safe parser for boolean-shaped env vars.
 *
 * `z.coerce.boolean()` is a footgun — it delegates to JS `Boolean(value)`,
 * which returns `true` for any non-empty string INCLUDING `"false"`. That
 * mis-parse silently broke magic-link email delivery on 2026-05-14:
 * `POSTBOX_ENABLED=false` in `.env` coerced to `true`, the adapter factory
 * entered the Postbox branch, hit missing creds, fell back to `StubAdapter`,
 * and the magic-link callback recorded its sends to a memory list while
 * Better Auth returned `{status:true}` to the client (anti-enumeration
 * policy). UI showed «Письмо отправлено», Mailpit stayed empty.
 *
 * Accepts the conventional env-var spellings; rejects anything else with a
 * clear error so a typo never silently flips a boolean.
 */
export const booleanEnv = (defaultValue: boolean) =>
	z.preprocess(
		(v) => {
			if (v === undefined || v === null) return defaultValue
			if (typeof v === 'boolean') return v
			if (typeof v === 'string') {
				const normalized = v.toLowerCase().trim()
				if (normalized === '') return defaultValue
				if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true
				if (normalized === 'false' || normalized === '0' || normalized === 'no') return false
			}
			return v // let z.boolean() reject — preserves type-safety
		},
		z.boolean({
			error: (issue) =>
				`Expected boolean env (true|false|1|0|yes|no|""), got ${JSON.stringify(issue.input)}`,
		}),
	)

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

	// Override gate для APP_MODE=production + DEMO_DEPLOYMENT=true foot-shot
	// combination (B1 hardening, 2026-05-19). DEFAULT FALSE — refuse to start.
	// Operator must consciously opt-in. Only intended для V2 multi-mode
	// architecture где demo + production tenants coexist в single deployment.
	APP_MODE_PERMITTED_DEMO_OVERRIDE: booleanEnv(false),

	// YDB
	YDB_CONNECTION_STRING: z.string().min(1),
	/**
	 * Credentials mode для YDB driver:
	 *   - unset/empty/"0": AnonymousCredentialsProvider (local dev YDB Docker)
	 *   - "1"/"true": MetadataCredentialsProvider (YC Serverless Container —
	 *     IAM token from metadata service 169.254.169.254). Q2 2026 canon.
	 */
	YDB_METADATA_CREDENTIALS: z.string().optional(),

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
	POSTBOX_ENABLED: booleanEnv(false),
	POSTBOX_ACCESS_KEY_ID: z.string().optional(),
	POSTBOX_SECRET_ACCESS_KEY: z.string().optional(),
	POSTBOX_ENDPOINT: z.string().default('https://postbox.cloud.yandex.net'),
	// Sender identity. Domain MUST be DKIM/SPF/DMARC-verified at Postbox before
	// production launch — see project_deferred_deploy_plan.md (infra-фаза).
	SMTP_HOST: z.string().default('localhost'),
	SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1125),
	EMAIL_FROM_ADDRESS: z.email(),
	EMAIL_FROM_NAME: z.string().default('HoReCa'),
	/**
	 * Reply-To address. Когда recipient жмёт «Reply» в transactional emails
	 * (sent с `noreply@…`), письмо направится к этому адресу вместо bounce.
	 * Canon 2026: `hi@sepshn.ru` (живой Yandex 360 inbox для домена). Если
	 * не set — Reply-To header опускается (recipient ответ bounce'нет).
	 */
	EMAIL_REPLY_TO_ADDRESS: z.email().optional(),

	// Yandex SmartCaptcha server key (`ysc2_...`) for POST /validate.
	// Optional: when unset, captcha enforcement is disabled (dev / CI).
	// When set, the Better Auth `before` hook rejects sign-up / sign-in /
	// magic-link without a valid captchaToken in the request body.
	// Bootstrapped via `yc smartcaptcha captcha get-secret-key <id>` into
	// Yandex Lockbox after first Terraform apply. Per
	// `feedback_yandex_cloud_only.md` — Yandex Cloud captcha (not Cloudflare
	// Turnstile) for 152-ФЗ data localization.
	SMARTCAPTCHA_SERVER_KEY: z.string().optional(),

	// Sprint C+ Round 7 v3 P0 fix 2026-05-25 — canonical Yandex SWS bypass token.
	//
	// SUPERSEDES Round 7 v2 SA-JWT canon (5-place rotation burden, custom verifier
	// non-canonical для 2026 RU SaaS). v3 canon: shared 32-byte token, validated
	// at two layers (defense-in-depth):
	//   1. Edge: SWS allow-rule priority 8500 — header `X-Bypass-Token` exact_match
	//      → skip Smart Protection ML scoring + skip ARL throttle.
	//   2. App: captcha-gate.ts timing-safe compare — backend ALSO checks header,
	//      bypass SmartCaptcha gate если match.
	//
	// Same Lockbox source (`sepshn-sws-bypass-token`) feeds оба layers — single
	// rotation step. 32-byte hex (256 bits entropy) + timing-safe compare =
	// canonical for shared-secret pattern на demo subdomain.
	//
	// Rotation lifecycle (1 step instead of v2's 5):
	//   yc lockbox secret add-version --id <id> --payload [...]
	//   curl PUT api.sourcecraft.tech/.../secrets/SWS_BYPASS_TOKEN
	//   bump version_id в terraform.tfvars → tofu apply → redeploy
	//
	// Unset (dev/local) → bypass disabled (real captcha enforced). См.
	// [[feedback_round_7_v3_sws_canon_2026_05_25]].
	SWS_BYPASS_TOKEN: z
		.string()
		.min(32, 'SWS_BYPASS_TOKEN must be ≥32 chars (32-byte hex = 64 chars typical)')
		.optional(),

	// Demo deployment flag — when `true`, captcha-gate bypasses validation
	// EVEN IF `SMARTCAPTCHA_SERVER_KEY` is set. Per `[[demo_strategy]]`:
	// public hosted demo (e.g. demo.sochi.ru) runs friction-free for
	// prospects evaluating product. Frontend pairs via `VITE_DEMO_DEPLOYMENT
	// =true` — must be set consistently. Mismatch (frontend off, backend on
	// OR vice-versa) yields blanket 403 because forms cannot mint a token
	// AND the gate refuses non-tokened requests.
	DEMO_DEPLOYMENT: booleanEnv(false),

	/**
	 * Round 14.6 — webhook signing secret for demo OTA mock channels (`YT`
	 * + `ETG` per-tenant + legacy `demo-tenant` showcase row). Single source
	 * of truth — `app.ts` + `auth.ts.afterCreateOrganization` both seed
	 * `webhookSecret` rows с этим значением; eliminates the prior
	 * three-copies-of-literal halfmeasure caught by canon
	 * `feedback_aggressive_delegacy`.
	 *
	 * Default placeholder marks the value as non-production explicitly.
	 * Deploy operator MUST override via Lockbox secret для any environment
	 * where prod-mode real channel integration coexists с demo OTA. In
	 * `APP_MODE=production` deploys где demo OTA disabled entirely, value
	 * is unused (мis `_demo/` mount env-gated).
	 */
	DEMO_WEBHOOK_SECRET: z
		.string()
		.min(16)
		.default('demo-mock-ota-webhook-secret-do-not-use-in-prod'),

	/**
	 * Round 14.6 — base URL targeted by demo OTA mock webhook emitters.
	 * Defaults к `http://localhost:8787` для local dev parity. Production
	 * deploy sets к the backend's own public-facing URL (so `/api/channel/
	 * webhooks/YT|ETG` receives the loopback CloudEvent).
	 */
	DEMO_WEBHOOK_TARGET_BASE_URL: z.string().url().default('http://localhost:8787'),

	// Sprint C+ Round 6 P1 fix 2026-05-24 (Performance scale architect):
	// Migration apply на cold start = 72 migrations × ~50ms checksum read = 3.6s
	// wall-clock в best case + risk of DDL race при multi-instance scaling.
	//
	// Canonical 2026 pattern (Stripe / Linear / Vercel): detach migrations OUT
	// of runtime container boot path. CI/deploy job runs `RUN_MIGRATIONS=true`
	// applier ONCE per deploy; runtime containers boot с RUN_MIGRATIONS=false
	// (default) и пропускают applier entirely.
	//
	// Behavior:
	//   RUN_MIGRATIONS=true  — apply migrations (used by deploy job + local dev)
	//   RUN_MIGRATIONS=false — skip migrations (default; runtime container path)
	//
	// Local dev: `pnpm migrate` script wraps applier с RUN_MIGRATIONS=true.
	// Tests: setupTestDb() уже applies separately, doesn't read this env.
	//
	// Backward-compat: default=true сохраняет current behavior. Operator
	// explicitly sets RUN_MIGRATIONS=false на runtime container env для cold-
	// start cut от 3.6s к ~50ms.
	RUN_MIGRATIONS: booleanEnv(true),

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

	// Payment provider selection (P1.1, 2026-05-18).
	//
	//   PAYMENT_PROVIDER=stub      — синхронный autocapture-stub (default dev/test).
	//                                Registered as `payment.stub` mode=`mock`.
	//   PAYMENT_PROVIDER=yookassa  — live ЮKassa REST (test_xxx ключи в sandbox).
	//                                Requires YOOKASSA_SHOP_ID + YOOKASSA_SECRET_KEY.
	//                                Registered as `payment.yookassa` mode=`sandbox`
	//                                (APP_MODE=sandbox) or `live` (APP_MODE=production).
	//
	// API base URL: единственный production endpoint у ЮKassa (api.yookassa.ru/v3) —
	// НЕТ отдельного sandbox host'а, sandbox mode определяется test_xxx prefix
	// в shopId+secretKey. Override only для network testing (mocked fetch, replay).
	//
	// Webhook: ЮKassa использует IP allowlist + GET-verify round-trip, NO HMAC.
	// См. `project_yookassa_canon_corrections.md` (2026-04-29 empirical).
	PAYMENT_PROVIDER: z.enum(['stub', 'yookassa']).default('stub'),
	YOOKASSA_SHOP_ID: z.string().optional(),
	YOOKASSA_SECRET_KEY: z.string().optional(),
	// B2 (2026-05-19): previous secret для 48h rotation grace. Operator flow:
	// set previous=current + current=new + deploy, wait 48h, unset previous.
	// Adapter retries 401s on current key с this previous one (logs warn).
	YOOKASSA_SECRET_KEY_PREVIOUS: z.string().optional(),
	YOOKASSA_API_BASE: z.url().default('https://api.yookassa.ru/v3'),

	// Vision OCR provider selection (P2, 2026-05-19).
	//
	//   VISION_PROVIDER=mock    — behaviour-faithful in-process simulator
	//                             (default dev/test). Registered `vision.mock`
	//                             mode=`mock`.
	//   VISION_PROVIDER=yandex  — live Yandex Cloud OCR (passport model).
	//                             Requires YC_VISION_API_KEY + YC_VISION_FOLDER_ID.
	//                             Registered `vision.yandex` mode=`sandbox`
	//                             (APP_MODE=sandbox) или `live` (APP_MODE=production).
	//
	// Endpoint: единственный — https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText
	// (Vision migrated к OCR namespace Q1 2026, empirical-verified). Auth via
	// `Api-Key <key>` + `x-folder-id` header (Api-Key carries no folder context).
	// Idempotency header: `Idempotency-Key` (Yandex Cloud canon — IETF spelling,
	// differs от ЮKassa `Idempotence-Key`).
	//
	// Cost: free 4 000 ₽ signup grant ≈ 30 000 passport scans (≈0.13 ₽/scan, Q2 2026).
	VISION_PROVIDER: z.enum(['mock', 'yandex']).default('mock'),
	YC_VISION_API_KEY: z.string().optional(),
	YC_VISION_FOLDER_ID: z.string().optional(),

	// Passport photo storage provider (Sprint B 2026-05-22).
	//   disabled — no storage, inputObjectKey=null в audit (Phase 1 minimal mode)
	//   mock     — behaviour-faithful (no actual S3 PUT, generates canonical key)
	//   yandex   — YC Object Storage (S3-compatible). Reuses S3_* env (canon).
	// Bucket needs lifecycle policy для 90-day auto-delete (Terraform).
	PASSPORT_PHOTO_STORAGE: z.enum(['disabled', 'mock', 'yandex']).default('disabled'),
	/** Separate bucket для passport scans (НЕ shared с property media). Optional — defaults к S3_BUCKET. */
	S3_BUCKET_PASSPORT_SCANS: z.string().optional(),

	/**
	 * Sprint C+ Senior P1-6 fix 2026-05-23d: internal API token for
	 * `/api/internal/ops-metrics` Prometheus-style drain endpoint. 32+ chars
	 * random recommended; resolved from Lockbox в production. Empty = endpoint
	 * disabled (returns 503).
	 */
	INTERNAL_OPS_TOKEN: z.string().default(''),

	// Right-most-trusted-proxy canon (P2.5 hardening, 2026-05-19).
	//
	// CSV list of CIDRs corresponding to OWN reverse-proxy infrastructure
	// (Yandex Cloud ALB, nginx ingress, etc). Only когда actual TCP peer falls
	// in this list, `X-Forwarded-For` header is parsed; otherwise XFF is IGNORED
	// (attacker-controlled) и TCP peer address is used directly.
	//
	// Defense against CVE-2025-68949-class spoofs: attacker connects directly,
	// forges `X-Forwarded-For: 185.71.76.5` (ЮKassa CIDR) → bypasses naive IP
	// allowlist. With this gate, XFF is parsed ONLY от trusted infra.
	//
	// Dev default: localhost + RFC1918 private ranges + Yandex Cloud internal
	// load balancer ranges (overrideable in deploy env per actual ALB CIDRs).
	TRUSTED_PROXY_CIDRS: z
		.string()
		.default('127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128')
		.transform((s) =>
			s
				.split(',')
				.map((v) => v.trim())
				.filter(Boolean),
		),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
	console.error('❌ Invalid environment variables:')
	console.error(z.prettifyError(parsed.error))
	process.exit(1)
}

// Cross-field invariant: VISION_PROVIDER=yandex requires both YC creds.
// Symmetric с PAYMENT_PROVIDER=yookassa invariant.
if (
	parsed.data.VISION_PROVIDER === 'yandex' &&
	(!parsed.data.YC_VISION_API_KEY || !parsed.data.YC_VISION_FOLDER_ID)
) {
	console.error(
		'❌ VISION_PROVIDER=yandex requires both YC_VISION_API_KEY and YC_VISION_FOLDER_ID. ' +
			'Get free signup grant (4 000 ₽ / 60 days) at https://yandex.cloud/ — service account ' +
			'needs role `ai.vision.user`.',
	)
	process.exit(1)
}

// Cross-field invariant: PAYMENT_PROVIDER=yookassa requires both creds.
// Kept outside Zod schema так чтобы envSchema shape стабилен (env.test.ts
// проверяет transform'ы без needing creds).
if (
	parsed.data.PAYMENT_PROVIDER === 'yookassa' &&
	(!parsed.data.YOOKASSA_SHOP_ID || !parsed.data.YOOKASSA_SECRET_KEY)
) {
	console.error(
		'❌ PAYMENT_PROVIDER=yookassa requires both YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY. ' +
			'Get sandbox credentials at https://yookassa.ru/my (test_xxx keys, free, instant).',
	)
	process.exit(1)
}

export const env = parsed.data
