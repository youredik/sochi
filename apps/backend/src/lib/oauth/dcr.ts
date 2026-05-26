/**
 * Round 13 — RFC 7591 Dynamic Client Registration skeleton.
 *
 * Canon: Round 8 P0 + Round 12 P1 deferred — Round 13 closes the «OAuth
 * onboarding gap» claim. Apaleo + Booking-com style integration partners
 * expect DCR to self-register without manual ops ticket.
 *
 * **Scope (Round 13 skeleton)** — in-memory storage. Phase-2 adds YDB
 * migration (oauth_clients table) + secret hashing + rotation lifecycle.
 *
 * **RFC 7591 §3.2 client metadata fields supported**:
 *   - client_name (required)
 *   - redirect_uris (required, array of HTTPS URIs)
 *   - grant_types (default ['authorization_code'])
 *   - token_endpoint_auth_method (default 'client_secret_basic')
 *   - contacts (optional, array of emails)
 *
 * **Generated fields**:
 *   - client_id (`sclient_${base64url}`)
 *   - client_secret (`whsec_dcr_${base64url}`)
 *   - client_id_issued_at (Unix seconds)
 *   - client_secret_expires_at (0 = no expiry — Phase-2 adds rotation)
 *
 * **Security canon**:
 *   - HTTPS-only redirect_uris (block javascript:, data:, http: schemes)
 *   - Length-bounded all fields (client_name ≤ 200, redirect_uris ≤ 5)
 *   - Reserved-word client_name blocklist (sepshn, admin, root → 403)
 */

import { randomBytes } from 'node:crypto'

export interface ClientMetadata {
	readonly client_name: string
	readonly redirect_uris: ReadonlyArray<string>
	readonly grant_types?: ReadonlyArray<string>
	readonly token_endpoint_auth_method?: string
	readonly contacts?: ReadonlyArray<string>
}

export interface RegisteredClient extends ClientMetadata {
	readonly client_id: string
	readonly client_secret: string
	readonly client_id_issued_at: number
	readonly client_secret_expires_at: number
	readonly grant_types: ReadonlyArray<string>
	readonly token_endpoint_auth_method: string
}

export type DcrError =
	| { readonly kind: 'invalid_redirect_uri'; readonly detail: string }
	| { readonly kind: 'invalid_client_metadata'; readonly detail: string }
	| { readonly kind: 'reserved_client_name' }

const MAX_CLIENT_NAME_LEN = 200
const MAX_REDIRECT_URIS = 5
const RESERVED_CLIENT_NAMES = ['sepshn', 'admin', 'root', 'system']

export function validateClientMetadata(
	input: unknown,
):
	| { readonly ok: true; readonly metadata: ClientMetadata }
	| { readonly ok: false; readonly error: DcrError } {
	if (input === null || typeof input !== 'object') {
		return { ok: false, error: { kind: 'invalid_client_metadata', detail: 'body must be object' } }
	}
	const obj = input as Record<string, unknown>

	if (typeof obj.client_name !== 'string' || obj.client_name.length === 0) {
		return {
			ok: false,
			error: { kind: 'invalid_client_metadata', detail: 'client_name required (non-empty string)' },
		}
	}
	if (obj.client_name.length > MAX_CLIENT_NAME_LEN) {
		return {
			ok: false,
			error: {
				kind: 'invalid_client_metadata',
				detail: `client_name exceeds ${MAX_CLIENT_NAME_LEN} chars`,
			},
		}
	}
	if (RESERVED_CLIENT_NAMES.includes(obj.client_name.toLowerCase())) {
		return { ok: false, error: { kind: 'reserved_client_name' } }
	}

	if (!Array.isArray(obj.redirect_uris) || obj.redirect_uris.length === 0) {
		return {
			ok: false,
			error: {
				kind: 'invalid_client_metadata',
				detail: 'redirect_uris required (non-empty array)',
			},
		}
	}
	if (obj.redirect_uris.length > MAX_REDIRECT_URIS) {
		return {
			ok: false,
			error: {
				kind: 'invalid_client_metadata',
				detail: `too many redirect_uris (max ${MAX_REDIRECT_URIS})`,
			},
		}
	}
	for (const uri of obj.redirect_uris) {
		if (typeof uri !== 'string') {
			return {
				ok: false,
				error: { kind: 'invalid_redirect_uri', detail: 'redirect_uri must be string' },
			}
		}
		// HTTPS-only per RFC 7591 §5; localhost http allowed for dev/CLI tools.
		if (!uri.startsWith('https://') && !uri.startsWith('http://localhost')) {
			return {
				ok: false,
				error: {
					kind: 'invalid_redirect_uri',
					detail: `redirect_uri must be HTTPS (or http://localhost dev): ${uri}`,
				},
			}
		}
		// Block dangerous schemes.
		if (
			uri.startsWith('javascript:') ||
			uri.startsWith('data:') ||
			uri.includes('\r') ||
			uri.includes('\n')
		) {
			return {
				ok: false,
				error: { kind: 'invalid_redirect_uri', detail: 'unsafe redirect_uri scheme or content' },
			}
		}
	}

	const metadata: ClientMetadata = {
		client_name: obj.client_name,
		redirect_uris: obj.redirect_uris as ReadonlyArray<string>,
		...(Array.isArray(obj.grant_types) && {
			grant_types: obj.grant_types as ReadonlyArray<string>,
		}),
		...(typeof obj.token_endpoint_auth_method === 'string' && {
			token_endpoint_auth_method: obj.token_endpoint_auth_method,
		}),
		...(Array.isArray(obj.contacts) && { contacts: obj.contacts as ReadonlyArray<string> }),
	}
	return { ok: true, metadata }
}

export function generateClientId(): string {
	return `sclient_${randomBytes(12).toString('base64url')}`
}

export function generateClientSecret(): string {
	return `whsec_dcr_${randomBytes(24).toString('base64url')}`
}

export interface DcrStore {
	readonly register: (metadata: ClientMetadata, nowMs?: number) => Promise<RegisteredClient>
	readonly get: (clientId: string) => Promise<RegisteredClient | null>
	readonly __clear: () => void
}

/**
 * In-memory DCR store (Round 13 skeleton). Phase-2 swaps к YDB-backed
 * с secret hash + rotation lifecycle.
 */
export function createInMemoryDcrStore(): DcrStore {
	const clients = new Map<string, RegisteredClient>()
	return {
		async register(metadata, nowMs = Date.now()) {
			const client: RegisteredClient = {
				client_id: generateClientId(),
				client_secret: generateClientSecret(),
				client_id_issued_at: Math.floor(nowMs / 1000),
				client_secret_expires_at: 0, // 0 = no expiry per RFC 7591 §3.2.1
				client_name: metadata.client_name,
				redirect_uris: metadata.redirect_uris,
				grant_types: metadata.grant_types ?? ['authorization_code'],
				token_endpoint_auth_method: metadata.token_endpoint_auth_method ?? 'client_secret_basic',
				...(metadata.contacts !== undefined && { contacts: metadata.contacts }),
			}
			clients.set(client.client_id, client)
			return client
		},
		async get(clientId) {
			return clients.get(clientId) ?? null
		},
		__clear() {
			clients.clear()
		},
	}
}
