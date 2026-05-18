/**
 * CIDR membership check для IPv4 + IPv6. Used by payment-webhook IP allowlist
 * (ЮKassa NO HMAC canon — IP is sole authenticator).
 *
 * Pure-fn, no deps. Сравнивает IP с CIDR в bit-level (right-shift к prefix-len).
 * IPv4 mapped через 32-bit BigInt, IPv6 через 128-bit BigInt. Wrong family →
 * false (no auto-conversion).
 *
 * Canon 2026 — `ipaddr.js@^2.4.0` widely used, но один-функц check проще
 * inline (zero deps, 80 LoC). See research session 2026-05-19.
 */

/** Parse IPv4 dotted-quad "a.b.c.d" → 32-bit BigInt. Returns null on invalid. */
function parseIpv4(ip: string): bigint | null {
	const parts = ip.split('.')
	if (parts.length !== 4) return null
	let acc = 0n
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const n = Number(part)
		if (n < 0 || n > 255) return null
		acc = (acc << 8n) | BigInt(n)
	}
	return acc
}

/** Parse IPv6 (compressed `::` supported) → 128-bit BigInt. Returns null on invalid. */
function parseIpv6(ip: string): bigint | null {
	// Reject mixed v4/v6 (`::ffff:1.2.3.4`) для simplicity — payment webhook
	// sources use pure v4 or pure v6, не mapped.
	if (ip.includes('.')) return null
	const doubleColon = ip.indexOf('::')
	let groups: string[]
	if (doubleColon === -1) {
		groups = ip.split(':')
		if (groups.length !== 8) return null
	} else {
		const left = ip.slice(0, doubleColon)
		const right = ip.slice(doubleColon + 2)
		const leftGroups = left.length === 0 ? [] : left.split(':')
		const rightGroups = right.length === 0 ? [] : right.split(':')
		const fillCount = 8 - leftGroups.length - rightGroups.length
		if (fillCount < 0) return null
		groups = [...leftGroups, ...Array<string>(fillCount).fill('0'), ...rightGroups]
	}
	if (groups.length !== 8) return null
	let acc = 0n
	for (const group of groups) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
		acc = (acc << 16n) | BigInt(Number.parseInt(group, 16))
	}
	return acc
}

type IpInfo = { value: bigint; family: 4 | 6; totalBits: 32 | 128 }

function parseIp(ip: string): IpInfo | null {
	if (ip.includes(':')) {
		const v6 = parseIpv6(ip)
		if (v6 === null) return null
		return { value: v6, family: 6, totalBits: 128 }
	}
	const v4 = parseIpv4(ip)
	if (v4 === null) return null
	return { value: v4, family: 4, totalBits: 32 }
}

function parseCidr(cidr: string): { network: IpInfo; prefixLen: number } | null {
	const slashIdx = cidr.indexOf('/')
	if (slashIdx === -1) return null
	const ipStr = cidr.slice(0, slashIdx)
	const prefixStr = cidr.slice(slashIdx + 1)
	if (!/^\d{1,3}$/.test(prefixStr)) return null
	const prefixLen = Number(prefixStr)
	const network = parseIp(ipStr)
	if (network === null) return null
	if (prefixLen < 0 || prefixLen > network.totalBits) return null
	return { network, prefixLen }
}

/**
 * Check if `ip` falls within `cidr` (e.g. `185.71.76.0/27`).
 * Returns `false` on parse error OR family mismatch.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
	const ipInfo = parseIp(ip)
	if (ipInfo === null) return false
	const cidrInfo = parseCidr(cidr)
	if (cidrInfo === null) return false
	if (ipInfo.family !== cidrInfo.network.family) return false
	if (cidrInfo.prefixLen === 0) return true
	const shift = BigInt(ipInfo.totalBits - cidrInfo.prefixLen)
	return ipInfo.value >> shift === cidrInfo.network.value >> shift
}
