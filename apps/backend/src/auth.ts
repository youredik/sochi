import { passkey } from '@better-auth/passkey'
import { type EntityKind, newId } from '@horeca/shared'
import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { magicLink } from 'better-auth/plugins/magic-link'
import { organization } from 'better-auth/plugins/organization'
import { ac, manager, owner, staff } from './access-control.ts'
import { ydbAdapter } from './db/better-auth-adapter.ts'
import { sql } from './db/index.ts'
import { toTs } from './db/ydb-helpers.ts'
import { env } from './env.ts'
import { evaluateCaptchaGate, extractClientIp } from './lib/auth/captcha-gate.ts'
import { magicLinkEmail } from './lib/auth/magic-link-email.ts'
import { logger } from './logger.ts'
import { createEmailAdapter } from './workers/lib/postbox-adapter.ts'

/** 14-day trial for newly created organizations. Defined here (not in a magic
 *  number) so billing code downstream reads the same constant. */
const TRIAL_DAYS = 14
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000

/**
 * Better Auth instance for HoReCa.
 *
 * Auth methods (canon 2026 — passwordless, full-stack):
 *   - **Magic-link** — sole signup AND sign-in entrypoint. BA built-in plugin
 *     (`magic-link`) with `disableSignUp: false` enables JIT user creation —
 *     same email-only flow serves both. 5-minute token TTL, single-use.
 *   - **WebAuthn passkey** — power-user upgrade after first sign-in (M9.5
 *     Phase D). Bound к platform authenticator (Touch/Face ID / Windows Hello).
 *   - **Yandex SmartCaptcha** — bot protection. Gates the magic-link `before`
 *     hook when SMARTCAPTCHA_SERVER_KEY is set; bypassed in dev/CI where unset.
 *   - **Email + password — DROPPED 2026-05-13** per `[[aggressive_delegacy]]` +
 *     `[[no_halfway]]`. Greenfield, no legacy users. Phishing surface, password-
 *     reset flows, lockout policies — all unnecessary for RU HoReCa SMB persona
 *     where magic-link + passkey covers the whole journey. The full removal
 *     (frontend + backend + tests + memory) shipped в one atomic commit;
 *     `auth-passwordless-canon` feedback memory documents the decision.
 *   - Organization plugin owns multi-tenancy — organization.id == tenantId.
 *   - Roles: owner / manager / staff (see access-control.ts).
 *   - Users CAN create organizations на старте. Once we have real customers this
 *     should flip to invitation-only like stankoff-v2 does.
 *
 * ID generation: typeid with prefix per model (usr_, ses_, org_, …).
 */

// Module-level email adapter: dual-mode transport (Mailpit dev / Postbox prod)
// picked once from env. Same instance reused for magic-link, invitation,
// password-reset emails — keeps SES/SMTP client connection warm.
const emailAdapter = createEmailAdapter(env, logger)
const emailFromAddress = `"${env.EMAIL_FROM_NAME}" <${env.EMAIL_FROM_ADDRESS}>`

/**
 * Magic-link token TTL — single source of truth.
 *
 * `expiresIn` (BA plugin config) takes seconds; `expiryMinutes` (email
 * template) takes minutes. Keep them derived from the same constant so
 * the value displayed to the user always matches the actual token life.
 *
 * 5 minutes balances security (short window — narrow phishing reuse) vs
 * UX (user has time to switch tabs to inbox + read the message).
 */
const MAGIC_LINK_TTL_SECONDS = 300
const MAGIC_LINK_TTL_MINUTES = MAGIC_LINK_TTL_SECONDS / 60

const BA_MODEL_TO_ENTITY: Record<string, EntityKind> = {
	user: 'user',
	session: 'session',
	account: 'account',
	verification: 'verification',
	organization: 'organization',
	member: 'member',
	invitation: 'invitation',
	// M9.5 Phase D — passkey() plugin model.
	passkey: 'passkey',
}

const trustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
	.map((o) => o.trim())
	.filter((o) => o.length > 0)

export const auth = betterAuth({
	database: ydbAdapter(sql),
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	trustedOrigins,
	// `emailAndPassword` block deliberately omitted — passwordless canon
	// (magic-link + passkey only) per `[[auth-passwordless-canon]]` 2026-05-13.
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // re-issue after 1 day of activity
		cookieCache: {
			enabled: true,
			maxAge: 5 * 60,
		},
	},
	hooks: {
		/**
		 * Captcha gate — runs BEFORE BA's own endpoint handler. Required to
		 * be first because the gate is anti-enumeration: if it ran after,
		 * an attacker could observe 200/403 timing differences on the auth
		 * endpoints and infer which emails exist without ever solving a
		 * captcha. Captcha-first ⇒ each enumeration probe costs the
		 * attacker one SmartCaptcha solution.
		 *
		 * Dev / CI: `SMARTCAPTCHA_SERVER_KEY` unset → gate returns
		 * `disabled` and we let the request through.
		 */
		before: createAuthMiddleware(async (ctx) => {
			const clientIp = ctx.request ? extractClientIp(ctx.request.headers) : undefined
			// Round 7 2026-05-24 — smoke-bypass header (case-insensitive lookup).
			// `ctx.request.headers` is Web Fetch Headers — `.get()` is case-insensitive.
			const smokeBypassToken = ctx.request?.headers.get('x-internal-smoke-bypass') ?? undefined
			const decision = await evaluateCaptchaGate(
				{
					path: ctx.path,
					body: ctx.body,
					...(clientIp ? { clientIp } : {}),
					...(smokeBypassToken ? { smokeBypassToken } : {}),
				},
				{
					...(env.SMARTCAPTCHA_SERVER_KEY ? { serverKey: env.SMARTCAPTCHA_SERVER_KEY } : {}),
					...(env.SMOKE_BYPASS_TOKEN ? { smokeBypassToken: env.SMOKE_BYPASS_TOKEN } : {}),
				},
			)
			if (!decision.pass) {
				if (decision.reason === 'missing_token') {
					throw new APIError('FORBIDDEN', {
						message: 'Captcha verification required',
						code: 'CAPTCHA_REQUIRED',
					})
				}
				logger.warn({ path: ctx.path, reason: decision.reason }, 'Captcha gate rejected request')
				throw new APIError('FORBIDDEN', {
					message: 'Captcha verification failed',
					code: 'CAPTCHA_FAILED',
				})
			}
		}),
	},
	databaseHooks: {
		session: {
			create: {
				before: async (session) => {
					// Auto-attach the user's first organization as active on login.
					// For solo owners with one org, UX is "login → you're in your org".
					const [rows] = await sql<[{ organizationId: string }]>`
						SELECT organizationId FROM member
						WHERE userId = ${session.userId}
						ORDER BY createdAt ASC
						LIMIT 1
					`
						.isolation('snapshotReadOnly')
						.idempotent(true)
					return {
						data: {
							...session,
							activeOrganizationId: rows[0]?.organizationId ?? null,
						},
					}
				},
			},
		},
	},
	plugins: [
		/**
		 * Magic-link sign-in (canon 2026 — passwordless first).
		 *
		 * `disableSignUp: false` allows JIT user creation — same button serves
		 * both sign-in and sign-up via email. Token TTL 5 min балансирует
		 * security (short window) vs UX (user has time to switch tabs).
		 *
		 * `sendMagicLink` callback delivers via our dual-mode email adapter:
		 * Mailpit SMTP (dev, see http://localhost:8125) or Yandex Postbox
		 * (prod, SES-compatible API). Failure is logged but not thrown —
		 * Better Auth returns 200 to caller regardless so we don't leak
		 * email-exists-or-not via timing.
		 */
		magicLink({
			expiresIn: MAGIC_LINK_TTL_SECONDS,
			disableSignUp: false,
			sendMagicLink: async ({ email, url }) => {
				const { subject, html, text } = magicLinkEmail({
					signInUrl: url,
					expiryMinutes: MAGIC_LINK_TTL_MINUTES,
				})
				const result = await emailAdapter.send({
					from: emailFromAddress,
					to: email,
					subject,
					html,
					text,
					// Reply-To канон 2026: from = noreply@ (отскок) →
					// `Reply-To: hi@sepshn.ru` направляет ответы recipient'а
					// к живому inbox. EMAIL_REPLY_TO env (optional, fallback к
					// noreply — bounce поведение прежнее).
					...(env.EMAIL_REPLY_TO_ADDRESS ? { replyTo: env.EMAIL_REPLY_TO_ADDRESS } : {}),
				})
				if (result.kind === 'sent') {
					logger.info({ messageId: result.messageId }, 'Magic-link email dispatched')
				} else {
					logger.warn(
						{ kind: result.kind, reason: result.reason },
						'Magic-link email delivery failed',
					)
				}
			},
		}),
		/**
		 * M9.5 Phase D — WebAuthn passkey support.
		 *
		 * Modern 2026/2027 canon (per @better-auth/passkey 1.6.9 + WebAuthn L3
		 * spec):
		 *   - `rpID` — eTLD+1 of the production origin (env.HOST)
		 *   - `origin` — full origin URL (env.PUBLIC_BASE_URL) — RP origin
		 *     binding mandatory против phishing attacks
		 *   - `attestation: 'none'` — privacy-preserving (no AAGUID disclosure)
		 *   - Platform attachment по умолчанию (Touch/Face ID, Windows Hello)
		 *
		 * 152-ФЗ compliance: биометрия НЕ покидает device, server stores только
		 * public key + counter. iCloud Keychain / Google PM sync — client-side.
		 */
		passkey({
			rpName: 'Сэпшн',
			rpID: env.HOST,
			origin: env.PUBLIC_BASE_URL,
			// 2026/2027 modern hardening per WebAuthn L3 + 152-ФЗ canon:
			authenticatorSelection: {
				// Platform-bound (Touch/Face ID, Windows Hello, Android fingerprint).
				// Cross-platform USB security keys excluded — operator UX optimization.
				authenticatorAttachment: 'platform',
				// Biometric verification mandatory — passkey без UV = просто credential.
				userVerification: 'required',
				// Discoverable credentials — enables passwordless flow без email field.
				residentKey: 'required',
			},
		}),
		organization({
			ac,
			roles: { owner, manager, staff },
			creatorRole: 'owner',
			allowUserToCreateOrganization: true,
			organizationLimit: 5,
			invitationExpiresIn: 7 * 24 * 60 * 60,
			cancelPendingInvitationsOnReInvite: true,
			organizationHooks: {
				/**
				 * Auto-populate `organizationProfile` 1:1 with the new organization.
				 *
				 * BA's `organization` table holds only the public fields it needs
				 * (name/slug/logo/createdAt/id). Every HoReCa-specific attribute —
				 * `plan`, `trialEndsAt`, `dpaAcceptedAt`, `inn`, `taxForm`, … —
				 * lives on `organizationProfile` and must exist for billing /
				 * compliance / downstream feature code to read a row by tenantId.
				 *
				 * Running here (not in a cron) guarantees the profile row exists
				 * the moment the org does. Previously flagged as blocker in
				 * `project_organization_profile_todo.md` — resolved.
				 *
				 * NB: UPSERT is idempotent. If BA ever retries createOrganization
				 * for the same id we don't want a duplicate PK violation.
				 */
				afterCreateOrganization: async ({ organization: org }) => {
					const now = new Date()
					const trialEndsAt = new Date(now.getTime() + TRIAL_MS)
					await sql`
						UPSERT INTO organizationProfile (
							\`organizationId\`, \`plan\`, \`trialEndsAt\`,
							\`createdAt\`, \`updatedAt\`
						) VALUES (
							${org.id}, ${'free'}, ${toTs(trialEndsAt)},
							${toTs(now)}, ${toTs(now)}
						)
					`
				},
			},
		}),
	],
	advanced: {
		database: {
			generateId: ({ model }) => {
				const kind = BA_MODEL_TO_ENTITY[model]
				if (!kind) {
					throw new Error(`No typeid prefix configured for Better Auth model: ${model}`)
				}
				return newId(kind)
			},
		},
	},
})
