/**
 * Vitest setup file — populates `process.env` with sensible test defaults
 * so any test that imports `apps/backend/src/env.ts` (directly or transitively
 * via app.ts / middleware) doesn't fail with "❌ Invalid environment variables"
 * → process.exit(1).
 *
 * Real values from `.env` win when present. Values here are placeholders
 * sufficient for env-schema validation only. Tests that actually exercise
 * the env-dependent feature (S3 upload, Postbox send, Better Auth) should
 * set their own values explicitly via `vi.stubEnv` inside the suite.
 *
 * Wire-up: referenced from `apps/backend/vitest.config.ts` `setupFiles`.
 */

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
