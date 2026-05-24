/**
 * CORS canonical 2026-05-25 — strict allowlist with function-style origin
 * resolver. Returns matched origin OR null (Hono omits ACAO header entirely
 * for null → preflight fails for untrusted origins).
 *
 * Why separate from `app.ts`: app.ts при импорте создаёт CDC consumers и
 * другие side-effects. `cors.test.ts` импортирует чистые функции отсюда
 * чтобы не triggerить CDC при parallel bun test. Pure-function isolation
 * canon (no side-effects in unit-testable modules).
 *
 * Gap-analysis P0 (empirical curl 2026-05-25):
 *   OPTIONS https://demo.sepshn.ru/api/v1/auth/sign-in/magic-link \
 *     -H 'Origin: https://attacker.example'
 *   → access-control-allow-origin: *  +  access-control-allow-credentials: true
 *
 * Invalid CORS (browsers reject `*`+credentials) but signals misconfig.
 * Function-style resolveCorsOrigin returns matched value or null →
 * Hono omits ACAO header entirely → preflight fails for untrusted origin.
 */
import { env } from './env.ts'

const trustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
	.map((o) => o.trim())
	.filter((o) => o.length > 0)

export const corsAllowlist = trustedOrigins.length > 0 ? trustedOrigins : [env.BETTER_AUTH_URL]

export function resolveCorsOrigin(origin: string): string | null {
	return corsAllowlist.includes(origin) ? origin : null
}
