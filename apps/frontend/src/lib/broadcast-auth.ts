/**
 * Multi-tab auth state propagation via BroadcastChannel.
 *
 * Chosen over `storage` events because:
 *   - BroadcastChannel is reactive *between tabs*, not across reload cycles
 *   - zero storage pollution (no cookie/localStorage writes)
 *   - MDN-stable since Safari 15.4, universally available in 2026 target
 *     browsers including Yandex.Browser
 *
 * What we broadcast:
 *   - `logout` — one tab signs out → every other tab invalidates session
 *     query and redirects to /login
 *   - `org:change` — org switcher in tab A → tab B re-resolves route
 *     context and follows to the new /o/{slug}/...
 *
 * What we DON'T broadcast (yet):
 *   - token-refresh coordination. Better Auth refreshes via `updateAge`
 *     sliding window on the server; browser tabs don't race here. If we
 *     later add explicit client-initiated refresh, add Web Locks
 *     (`navigator.locks.request`) for single-flight coordination (2026
 *     hybrid pattern per Loke.dev "Solving Browser Concurrency").
 *
 * Message contract is versioned (`v: 1`) so future breaking changes can
 * be rolled out with a compatibility shim.
 */

const CHANNEL_NAME = 'horeca.auth'

type AuthBroadcast =
	| { v: 1; type: 'logout' }
	| { v: 1; type: 'org:change'; organizationId: string; slug: string }

let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
	if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
	if (channel === null) channel = new BroadcastChannel(CHANNEL_NAME)
	return channel
}

/** Broadcast `logout` to all other tabs of the same origin. No-op in SSR/older browsers. */
export function broadcastLogout(): void {
	getChannel()?.postMessage({ v: 1, type: 'logout' } satisfies AuthBroadcast)
}

/** Broadcast `org:change` so peer tabs re-resolve their active org. */
export function broadcastOrgChange(organizationId: string, slug: string): void {
	getChannel()?.postMessage({
		v: 1,
		type: 'org:change',
		organizationId,
		slug,
	} satisfies AuthBroadcast)
}

/**
 * Subscribe to auth broadcasts. Returns a disposer. Handlers are defensive:
 * unknown message shapes are ignored silently (future-version compatibility).
 */
export function subscribeAuthBroadcasts(handlers: {
	onLogout?: () => void
	onOrgChange?: (organizationId: string, slug: string) => void
}): () => void {
	const ch = getChannel()
	if (!ch) return () => {}
	const listener = (event: MessageEvent<AuthBroadcast>) => {
		const msg = event.data
		if (!msg || typeof msg !== 'object' || msg.v !== 1) return
		if (msg.type === 'logout') handlers.onLogout?.()
		else if (msg.type === 'org:change') handlers.onOrgChange?.(msg.organizationId, msg.slug)
	}
	ch.addEventListener('message', listener)
	return () => ch.removeEventListener('message', listener)
}
