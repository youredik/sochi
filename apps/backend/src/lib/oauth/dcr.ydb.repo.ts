/**
 * Round 14 Phase E1 — YDB-backed DCR store.
 *
 * Closes Round 13 honest-scope limit: in-memory store invalidated all
 * registrations on restart. YDB persistence makes registered clients survive
 * deploys / failovers / cold-starts — actual «OAuth onboarding gap» closure.
 *
 * Security canon:
 *   - `clientSecretHash` stored, NOT plaintext. scrypt with random salt.
 *   - Default tenantId = `'public'` (DCR is open-registration; finer
 *     tenant scoping is Phase-3 when admin-issued clients land).
 *   - `revokedAt` soft-delete column для compliance (152-ФЗ retention).
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { sql as SQL } from '../../db/index.ts'
import {
	type ClientMetadata,
	type DcrStore,
	generateClientId,
	generateClientSecret,
	type RegisteredClient,
} from './dcr.ts'

type SqlInstance = typeof SQL

const scryptAsync = promisify(scrypt)
const SCRYPT_KEY_LEN = 64
const SCRYPT_SALT_LEN = 16

/** Hash plaintext secret using scrypt + random salt. Format: `scrypt$<salt-hex>$<key-hex>`. */
async function hashSecret(plaintext: string): Promise<string> {
	const salt = randomBytes(SCRYPT_SALT_LEN)
	const derived = (await scryptAsync(plaintext, salt, SCRYPT_KEY_LEN)) as Buffer
	return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** Verify plaintext secret against stored hash. Constant-time compare. */
export async function verifySecret(plaintext: string, stored: string): Promise<boolean> {
	const parts = stored.split('$')
	if (parts.length !== 3 || parts[0] !== 'scrypt') return false
	const saltHex = parts[1]
	const keyHex = parts[2]
	if (saltHex === undefined || keyHex === undefined) return false
	const salt = Buffer.from(saltHex, 'hex')
	const expected = Buffer.from(keyHex, 'hex')
	const derived = (await scryptAsync(plaintext, salt, expected.length)) as Buffer
	return derived.length === expected.length && timingSafeEqual(derived, expected)
}

const DEFAULT_DCR_TENANT = 'public'

interface YdbDcrRow {
	tenantId: string
	clientId: string
	clientSecretHash: string
	clientName: string
	redirectUrisJson: string
	grantTypesJson: string
	tokenEndpointAuthMethod: string
	contactsJson: string | null
	clientIdIssuedAt: Date
	clientSecretExpiresAt: Date | null
	revokedAt: Date | null
}

function rowToClient(row: YdbDcrRow, plaintextSecretOnRegister?: string): RegisteredClient {
	// On register we have plaintext to return once; on read we never expose
	// the secret (signal absence via empty string per RFC 7591 §4.1).
	return {
		client_id: row.clientId,
		client_secret: plaintextSecretOnRegister ?? '',
		client_id_issued_at: Math.floor(row.clientIdIssuedAt.getTime() / 1000),
		client_secret_expires_at:
			row.clientSecretExpiresAt === null
				? 0
				: Math.floor(row.clientSecretExpiresAt.getTime() / 1000),
		client_name: row.clientName,
		redirect_uris: JSON.parse(row.redirectUrisJson) as ReadonlyArray<string>,
		grant_types: JSON.parse(row.grantTypesJson) as ReadonlyArray<string>,
		token_endpoint_auth_method: row.tokenEndpointAuthMethod,
		...(row.contactsJson !== null && {
			contacts: JSON.parse(row.contactsJson) as ReadonlyArray<string>,
		}),
	}
}

/**
 * Build YDB-backed DCR store. Implements same `DcrStore` interface as
 * `createInMemoryDcrStore` — swap-compatible.
 */
export function createYdbDcrStore(sql: SqlInstance): DcrStore {
	return {
		async register(metadata: ClientMetadata, nowMs = Date.now()) {
			const clientId = generateClientId()
			const clientSecret = generateClientSecret()
			const secretHash = await hashSecret(clientSecret)
			const issuedAt = new Date(nowMs)
			const grantTypes = metadata.grant_types ?? ['authorization_code']
			const tokenAuthMethod = metadata.token_endpoint_auth_method ?? 'client_secret_basic'
			await sql`
				INSERT INTO oauthClient (
					\`tenantId\`, \`clientId\`, \`clientSecretHash\`, \`clientName\`,
					\`redirectUrisJson\`, \`grantTypesJson\`, \`tokenEndpointAuthMethod\`,
					\`contactsJson\`, \`clientIdIssuedAt\`, \`clientSecretExpiresAt\`, \`revokedAt\`
				) VALUES (
					${DEFAULT_DCR_TENANT}, ${clientId}, ${secretHash}, ${metadata.client_name},
					${JSON.stringify(metadata.redirect_uris)},
					${JSON.stringify(grantTypes)},
					${tokenAuthMethod},
					${metadata.contacts !== undefined ? JSON.stringify(metadata.contacts) : null},
					${issuedAt}, ${null}, ${null}
				)
			`
			return rowToClient(
				{
					tenantId: DEFAULT_DCR_TENANT,
					clientId,
					clientSecretHash: secretHash,
					clientName: metadata.client_name,
					redirectUrisJson: JSON.stringify(metadata.redirect_uris),
					grantTypesJson: JSON.stringify(grantTypes),
					tokenEndpointAuthMethod: tokenAuthMethod,
					contactsJson: metadata.contacts !== undefined ? JSON.stringify(metadata.contacts) : null,
					clientIdIssuedAt: issuedAt,
					clientSecretExpiresAt: null,
					revokedAt: null,
				},
				clientSecret,
			)
		},

		async get(clientId: string) {
			const [rows = []] = await sql<YdbDcrRow[]>`
				SELECT tenantId, clientId, clientSecretHash, clientName,
					redirectUrisJson, grantTypesJson, tokenEndpointAuthMethod, contactsJson,
					clientIdIssuedAt, clientSecretExpiresAt, revokedAt
				FROM oauthClient
				WHERE clientId = ${clientId}
				LIMIT 1
			`
				.isolation('snapshotReadOnly')
				.idempotent(true)
			const row = rows[0]
			if (row === undefined) return null
			if (row.revokedAt !== null) return null
			return rowToClient(row)
		},

		__clear() {
			// YDB store has no in-memory state; clear is a no-op for tests
			// that use the in-memory variant. Production DB cleanup uses
			// migration or admin endpoint, NOT this method.
		},
	}
}
