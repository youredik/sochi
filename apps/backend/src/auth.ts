import { type EntityKind, newId } from '@horeca/shared'
import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins/organization'
import { ac, manager, owner, staff } from './access-control.ts'
import { ydbAdapter } from './db/better-auth-adapter.ts'
import { sql } from './db/index.ts'
import { toTs } from './db/ydb-helpers.ts'
import { env } from './env.ts'

/** 14-day trial for newly created organizations. Defined here (not in a magic
 *  number) so billing code downstream reads the same constant. */
const TRIAL_DAYS = 14
const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000

/**
 * Better Auth instance for HoReCa.
 *
 * MVP constraints (explicit):
 *   - Only email + password. No magic link, no OAuth, no passkeys on MVP.
 *   - Email verification is OFF on MVP so owners can register and click around
 *     without an email round-trip. Turn ON before the first real customer.
 *   - Organization plugin owns multi-tenancy — organization.id == tenantId.
 *   - Roles: owner / manager / staff (see access-control.ts).
 *   - Users CAN create organizations on MVP. Once we have real customers this
 *     should flip to invitation-only like stankoff-v2 does.
 *
 * ID generation: typeid with prefix per model (usr_, ses_, org_, …).
 */

const BA_MODEL_TO_ENTITY: Record<string, EntityKind> = {
	user: 'user',
	session: 'session',
	account: 'account',
	verification: 'verification',
	organization: 'organization',
	member: 'member',
	invitation: 'invitation',
}

const trustedOrigins = env.BETTER_AUTH_TRUSTED_ORIGINS.split(',')
	.map((o) => o.trim())
	.filter((o) => o.length > 0)

export const auth = betterAuth({
	database: ydbAdapter(sql),
	secret: env.BETTER_AUTH_SECRET,
	baseURL: env.BETTER_AUTH_URL,
	trustedOrigins,
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: false,
		autoSignIn: true,
		minPasswordLength: 8,
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // re-issue after 1 day of activity
		cookieCache: {
			enabled: true,
			maxAge: 5 * 60,
		},
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
