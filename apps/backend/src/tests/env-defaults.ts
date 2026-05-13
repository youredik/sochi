/**
 * Bun test preload file (Phase 16, 2026-05-13 closure) — populates
 * `process.env` with sensible test defaults so any test that imports
 * `apps/backend/src/env.ts` (directly or transitively via app.ts /
 * middleware) doesn't fail with "❌ Invalid environment variables"
 * → process.exit(1).
 *
 * Real values from `.env` win when present. Values here are placeholders
 * sufficient for env-schema validation only. Tests that actually exercise
 * the env-dependent feature (S3 upload, Postbox send, Better Auth) should
 * set their own values explicitly inside the suite.
 *
 * TZ canon: bun:test defaults to `TZ=UTC` for deterministic time semantics
 * (verified empirically 2026-05-13: `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone === 'UTC'` inside `bun test`, vs system TZ outside). Sochi
 * HoReCa runs on Yandex Cloud RU-CENTRAL1 (Moscow region, UTC+3 no DST
 * since 2014). Forcing `TZ=Europe/Moscow` in tests gives prod-parity TZ
 * semantics — required by ical-generator's `TZID=Europe/Moscow` rendering
 * (which formats Date in process-local TZ; under UTC it labels UTC digits
 * as Moscow, producing 11:00 instead of 14:00 for `14:00:00+03:00` input).
 *
 * Wire-up: referenced from `apps/backend/bunfig.toml` `[test] preload`.
 */

if (process.env.TZ === undefined) {
	process.env.TZ = 'Europe/Moscow'
}

const defaults: Record<string, string> = {
	YDB_CONNECTION_STRING: 'grpc://localhost:2236/local',
	BETTER_AUTH_SECRET: 'test-secret-32-chars-minimum-padding-here',
	BETTER_AUTH_URL: 'http://localhost:8787',
	BETTER_AUTH_TRUSTED_ORIGINS: 'http://localhost:5273',
	S3_ENDPOINT: 'http://localhost:9100',
	S3_REGION: 'ru-central1',
	S3_ACCESS_KEY_ID: 'test',
	S3_SECRET_ACCESS_KEY: 'test',
	S3_BUCKET: 'test-bucket',
	EMAIL_FROM_ADDRESS: 'noreply@sochi.local',
	EMAIL_FROM_NAME: 'HoReCa Test',
}

for (const [key, value] of Object.entries(defaults)) {
	if (process.env[key] === undefined) process.env[key] = value
}
