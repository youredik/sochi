/**
 * Canonical client IP resolution (B7 XFF refactor, 2026-05-19).
 *
 * Right-most-trusted-proxy walking canon (MDN Q2 2026 / OWASP A10 / OneUptime
 * 2026 / CVE-2025-68949 defense). Supersedes the legacy «leftmost wins»
 * anti-pattern that admitted XFF spoofing for rate-limiting + bot-scoring
 * signals.
 *
 * Single source of truth for:
 *   - Webhook IP allowlists (ЮKassa et al.) — `resolveClientIp` (pure)
 *   - Rate-limit bucket keys + consent-log audit — `extractClientIpFromContext`
 *     (Hono Context wrapper, sync — `keyGenerator` cannot await)
 *   - Direct sync callsites с pre-extracted `Headers` — `resolveClientIpSync`
 *
 * Why right-most-trusted-proxy:
 *   Direct attacker → forge XFF header → backend reads leftmost → infinite
 *   bucket keys → rate-limit bypass / DoS. Walking right-to-left through
 *   the chain, skipping known-trusted hops, yields the FIRST unforgeable
 *   address: the last hop the attacker could not spoof.
 */

import { isIpInCidr } from './cidr.ts'

export interface ResolveClientIpInput {
	readonly headers: Headers
	/**
	 * Actual TCP peer address (`getConnInfo(c).remote.address` on Bun/Node).
	 * `null` для test harnesses or runtimes that don't expose it — falls back
	 * к XFF chain right-walk only.
	 */
	readonly tcpRemoteAddress: string | null
	readonly trustedProxyCidrs: readonly string[]
}

/**
 * Decision tree:
 *
 *   1. tcpRemoteAddress set AND NOT в trustedProxyCidrs →
 *      Direct attacker connection. XFF is fully attacker-controlled.
 *      Return TCP peer (the ONLY unforgeable hop).
 *
 *   2. tcpRemoteAddress set AND IS в trustedProxyCidrs →
 *      Behind own reverse proxy. Walk XFF right-to-left, skip trusted hops;
 *      first non-trusted entry = real client. All hops trusted (rare): fall
 *      к chain[0] per MDN best-effort.
 *
 *   3. tcpRemoteAddress null (tests / runtimes without conn info) →
 *      Best-effort XFF/x-real-ip with same right-to-left walk.
 */
/**
 * Sprint C+ Round 6 self-review fix 2026-05-24 (Security re-pentest P1):
 * Normalize IP string: strip IPv6 brackets + port suffix BEFORE returning.
 *
 * Raw XFF can contain `[2001:db8::1]:443` или `192.0.2.1:8080`. Without
 * normalization, two different actual IPs may produce DIFFERENT bucket keys
 * (one bracketed, one not) → bucket-collision DoS:
 *   - All malformed clients sharing bucket «`[2001:db8::1]:443`»
 *   - All `'anonymous'` collapse cases (when parseIpv6 rejects bracketed form
 *     → trusted check throws → fallback к anonymous bucket)
 *
 * Normalization:
 *   `[::1]:80`           → `::1`
 *   `192.0.2.1:8080`     → `192.0.2.1`
 *   `2001:db8::1`        → `2001:db8::1`  (unchanged)
 *   `192.0.2.1`          → `192.0.2.1`    (unchanged)
 *   `[::ffff:192.0.2.1]` → `::ffff:192.0.2.1`
 *
 * IPv4-mapped-IPv6 NOT collapsed к IPv4 (keep canonical form per RFC 4291).
 */
function normalizeIpString(ip: string): string {
	const trimmed = ip.trim()
	// Bracketed IPv6 (with optional port): `[<ipv6>]` or `[<ipv6>]:<port>`
	const bracketed = trimmed.match(/^\[([^\]]+)\](?::\d+)?$/)
	if (bracketed?.[1]) return bracketed[1]
	// IPv4 с port: exactly 4 dot-separated digits + colon + port
	const ipv4Port = trimmed.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/)
	if (ipv4Port?.[1]) return ipv4Port[1]
	// IPv6 без brackets уже canonical; IPv4 без port same. Return as-is.
	return trimmed
}

export function resolveClientIp(input: ResolveClientIpInput): string | null {
	const { headers, trustedProxyCidrs } = input
	// Empty-string normalization — `getConnInfo().remote.address` rarely returns
	// `''` but defensive guard keeps the right-walk fallback path intact.
	const tcpRemoteAddress =
		input.tcpRemoteAddress !== null && input.tcpRemoteAddress.length > 0
			? normalizeIpString(input.tcpRemoteAddress)
			: null
	const isTrustedTcpPeer =
		tcpRemoteAddress !== null && trustedProxyCidrs.some((c) => isIpInCidr(tcpRemoteAddress, c))

	if (tcpRemoteAddress !== null && !isTrustedTcpPeer) {
		return tcpRemoteAddress
	}

	const xff = headers.get('x-forwarded-for')
	if (xff !== null && xff.length > 0) {
		const chain = xff
			.split(',')
			.map((s) => normalizeIpString(s))
			.filter((s) => s.length > 0)
		for (let i = chain.length - 1; i >= 0; i--) {
			const ip = chain[i]
			if (ip === undefined) continue
			const trusted = trustedProxyCidrs.some((c) => isIpInCidr(ip, c))
			if (!trusted) return ip
		}
		// All hops trusted — MDN best-effort fallback к claimed originator.
		const first = chain[0]
		if (first !== undefined) return first
	}
	const xri = headers.get('x-real-ip')
	if (xri !== null && xri.length > 0) return normalizeIpString(xri)
	return tcpRemoteAddress
}

/**
 * Sync variant для callsites that cannot await (rate-limit keyGenerator
 * is sync per `hono-rate-limiter` signature). Skips the `getConnInfo` TCP-peer
 * lookup и falls к XFF right-walk only — strictly weaker но still right-most-
 * trusted-proxy canon, NOT leftmost.
 *
 * Production note: in Bun/Node runtimes where ALB terminates TLS и forwards
 * с TRUSTED_PROXY_CIDRS-matched source, the TCP peer would always be trusted
 * и we'd walk XFF anyway — so this sync variant matches that path. Direct
 * (non-ALB) attackers reach us only в local dev / misconfigured deploys.
 */
export function resolveClientIpSync(
	headers: Headers,
	trustedProxyCidrs: readonly string[],
): string {
	const ip = resolveClientIp({
		headers,
		tcpRemoteAddress: null,
		trustedProxyCidrs,
	})
	return ip ?? 'anonymous'
}

/**
 * Hono-Context-friendly sync wrapper — constructs `Headers` from the two
 * relevant header values via `c.req.header` (preserves Hono Context mock
 * compatibility used в structural unit tests) and delegates к
 * `resolveClientIpSync`. Use for inline route IP extraction (consent log,
 * audit trail, magic-link `fromIp`, tupleStore keys, etc.) — replaces the
 * legacy `c.req.header('x-forwarded-for')?.split(',')[0]` leftmost anti-pattern.
 */
export function extractClientIpFromContext(
	c: { req: { header: (name: string) => string | undefined } },
	trustedProxyCidrs: readonly string[],
): string {
	const headers = new Headers()
	const xff = c.req.header('x-forwarded-for')
	if (xff) headers.set('x-forwarded-for', xff)
	const xri = c.req.header('x-real-ip')
	if (xri) headers.set('x-real-ip', xri)
	return resolveClientIpSync(headers, trustedProxyCidrs)
}
