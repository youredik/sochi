/**
 * 152-ФЗ-compliant anonymization pipeline for RUM payloads — M9.widget.7 / D8.
 *
 * web-vitals 5.x attribution build emits CSS-selector strings that pinpoint
 * the interaction target. Per плана §2 D8 + R2 §4 (152-ФЗ ст. 3 ч. 1) such
 * selectors ARE ПДн when they reference forms/inputs:
 *
 *   `body > main > form > input[name="passport_serial"]`  ← passport ID 🚨
 *   `button[aria-label="Удалить заказ № 12345"]`         ← order ID 🚨
 *   `#user-12345-checkout`                                ← user ID 🚨
 *
 * This module MUST run on every metric BEFORE network send. The RU
 * regulator (Roskomnadzor) treats UA strings as pseudo-identifier (Class B
 * ПДн), so we bucket those as well.
 *
 * Three exported helpers + IP truncate (lives in `@horeca/shared/rum` because
 * it runs server-edge):
 *   - `scrubSelector(s)` — strip attribute values + IDs
 *   - `bucketUserAgent(ua)` — UA-string → coarse bucket (browser/os/mobile)
 *   - `scrubUrl(href)` — keep pathname only, drop query / hash / origin
 *
 * Tests in `anonymize.test.ts` cover 8 ANON adversarial cases per plan §5.
 */

/**
 * Sensitive HTML attributes whose **values** must be stripped from CSS-selector
 * strings. Names are kept (structural) but values become `*`.
 *
 * List per OWASP CSS-Selector Injection canon + 152-ФЗ ст. 3 ч. 1:
 * any free-form text input from `name`, `value`, `placeholder`, `title`,
 * `alt`, `aria-label`, `aria-labelledby`, `aria-describedby` may carry ПДн
 * (typed payload OR free-text label). `data-*` is wildcard-stripped because
 * apps frequently encode IDs there (`data-order-id="..."`).
 */
const SENSITIVE_ATTR_NAMES: readonly string[] = [
	'name',
	'value',
	'placeholder',
	'title',
	'alt',
	'aria-label',
	'aria-labelledby',
	'aria-describedby',
	'aria-valuenow',
	'aria-valuetext',
	'href',
	'src',
] as const

/**
 * Match `[attr="value"]`, `[attr='value']`, `[attr=value]`, plus `[attr~="..."]`,
 * `[attr|="..."]`, `[attr^="..."]`, `[attr$="..."]`, `[attr*="..."]` operators.
 *
 * NOT a regex — manual scan keeps us robust against pathological inputs
 * (deeply nested quotes/escapes that defeat naive regexes). The selector grammar
 * is shallow enough that one pass over the string is sufficient.
 */
function stripAttributeValues(selector: string): string {
	let out = ''
	let i = 0
	while (i < selector.length) {
		if (selector[i] !== '[') {
			out += selector[i]
			i++
			continue
		}
		// Find matching `]` (selectors can't contain `]` outside of strings).
		const closeIdx = findClosingBracket(selector, i)
		if (closeIdx === -1) {
			// Unbalanced bracket — keep verbatim, defensive.
			out += selector.slice(i)
			break
		}
		const inner = selector.slice(i + 1, closeIdx)
		out += `[${normalizeAttribute(inner)}]`
		i = closeIdx + 1
	}
	return out
}

function findClosingBracket(s: string, openIdx: number): number {
	let inSingle = false
	let inDouble = false
	for (let i = openIdx + 1; i < s.length; i++) {
		const ch = s[i]
		if (ch === '\\') {
			i++
			continue
		}
		if (ch === "'" && !inDouble) inSingle = !inSingle
		else if (ch === '"' && !inSingle) inDouble = !inDouble
		else if (ch === ']' && !inSingle && !inDouble) return i
	}
	return -1
}

/**
 * Inside a `[...]` block, find first operator (`=`, `~=`, `|=`, `^=`, `$=`, `*=`)
 * and replace value with `*` IF attribute name is in SENSITIVE_ATTR_NAMES.
 * `data-*` always scrubbed (wildcard prefix).
 */
function normalizeAttribute(inner: string): string {
	const opMatch = inner.match(/^([\w-]+)(\s*[~|^$*]?=\s*)(.*)$/)
	if (!opMatch) return inner
	const [, name = '', op = '='] = opMatch
	const isData = name.startsWith('data-')
	const isSensitive = SENSITIVE_ATTR_NAMES.includes(name)
	if (!isData && !isSensitive) return inner
	const trimmedOp = op.replace(/\s/g, '')
	return `${name}${trimmedOp}*`
}

/**
 * Strip `#id` (DOM IDs) — IDs frequently encode user / order / record numbers
 * (`#user-12345`, `#order-INV-2026-0001`) → ПДн by linkability under 152-ФЗ.
 * Replaces with `#*` to preserve structural shape.
 */
function stripIds(selector: string): string {
	return selector.replace(/#[^\s>+~,.[\]]+/g, '#*')
}

/**
 * Public entry point — scrub a CSS-selector path of attribute-values + IDs.
 * Class names are kept (rarely PII; coarse-grained: `.btn-primary`,
 * `.cart-item`). Element tags + structural combinators (` `, `>`, `+`, `~`,
 * `,`) preserved verbatim.
 *
 * @param selector raw CSS selector from web-vitals attribution
 * @returns scrubbed selector safe for cross-tenant aggregation
 *
 * @example
 * scrubSelector('input[name="passport_serial"]')
 * // → 'input[name=*]'
 *
 * scrubSelector('#user-12345 > button[aria-label="Удалить"]')
 * // → '#* > button[aria-label=*]'
 *
 * scrubSelector('body > main.container > form#checkout > input[type=email]')
 * // → 'body > main.container > form#* > input[type=email]'   (type kept; not PII)
 */
export function scrubSelector(selector: string | null | undefined): string {
	if (typeof selector !== 'string') return ''
	if (selector.length === 0) return ''
	// Hard cap to prevent regex DOS via pathological input.
	const truncated = selector.slice(0, 2048)
	return stripIds(stripAttributeValues(truncated))
}

// ---------------------------------------------------------------------------
// User-Agent bucketing
// ---------------------------------------------------------------------------

import type { RumUaBucket } from '@horeca/shared/rum'

/**
 * Bucket UA-string into low-cardinality `{browser, os, mobile}` triple.
 *
 * Browser / OS detection is intentionally coarse (Chrome family includes
 * Edge < 79; Safari excludes Chrome on iOS by checking Chrome/CriOS first).
 * Mobile flag uses the standard `Mobi`/`Android`/`iPhone`/`iPad` triggers.
 *
 * NOT a UA-parser library: 50+ KB transient bundle for one boolean per axis.
 * If telemetry shows a bucket leaking high-resolution data we add another
 * branch here.
 *
 * @example
 * bucketUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
 * // → { browser: 'safari', os: 'ios', mobile: true }
 */
export function bucketUserAgent(ua: string | null | undefined): RumUaBucket {
	if (typeof ua !== 'string' || ua.length === 0) {
		return { browser: 'other', os: 'other', mobile: false }
	}
	const lower = ua.toLowerCase()

	// Browser — order matters (Edg/Edge wins over Chrome; Chrome/CriOS wins
	// over Safari on iOS).
	let browser: RumUaBucket['browser'] = 'other'
	if (lower.includes('edg/') || lower.includes('edge/')) browser = 'edge'
	else if (lower.includes('opr/') || lower.includes('opera')) browser = 'opera'
	else if (lower.includes('firefox/') || lower.includes('fxios/')) browser = 'firefox'
	else if (lower.includes('chrome/') || lower.includes('crios/')) browser = 'chrome'
	else if (lower.includes('safari/') && lower.includes('version/')) browser = 'safari'

	// OS detection.
	let os: RumUaBucket['os'] = 'other'
	if (lower.includes('iphone') || lower.includes('ipad') || lower.includes('ipod')) os = 'ios'
	else if (lower.includes('android')) os = 'android'
	else if (lower.includes('windows')) os = 'windows'
	else if (lower.includes('mac os x') || lower.includes('macintosh')) os = 'macos'
	else if (lower.includes('linux')) os = 'linux'

	// Mobile flag.
	const mobile =
		lower.includes('mobi') ||
		lower.includes('android') ||
		lower.includes('iphone') ||
		lower.includes('ipad') ||
		lower.includes('ipod')

	return { browser, os, mobile }
}

// ---------------------------------------------------------------------------
// URL scrubbing
// ---------------------------------------------------------------------------

/**
 * Strip a URL down to its pathname only — drop origin / query / hash.
 *
 * Query strings + URL fragments commonly carry PII (`?token=...`,
 * `?email=...`, `#magic-link-jwt=...`). Origin is kept implicit (we know it
 * from server-side request headers; including it again leaks nothing but
 * doubles cardinality).
 *
 * @example
 * scrubUrl('https://demo-sirius.host/widget/demo-sirius?utm=email&token=abc')
 * // → '/widget/demo-sirius'
 *
 * scrubUrl('/book/demo-sirius/inv-2026-001#voucher')
 * // → '/book/demo-sirius/inv-2026-001'
 */
export function scrubUrl(href: string | null | undefined): string {
	if (typeof href !== 'string' || href.length === 0) return '/'
	try {
		// Use a synthetic base so relative paths parse correctly.
		const url = new URL(href, 'https://anonymize.local')
		return url.pathname.length > 0 ? url.pathname : '/'
	} catch {
		// Last-ditch: take the path-looking prefix manually.
		const noHash = href.split('#', 1)[0] ?? ''
		const noQuery = noHash.split('?', 1)[0] ?? ''
		return noQuery.length > 0 ? noQuery : '/'
	}
}
