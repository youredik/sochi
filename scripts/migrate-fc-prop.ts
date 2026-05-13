/**
 * Phase 16 (2026-05-13) — bracket-aware codemod for `*Test.prop([arbs])(name, fn)`
 * → `test(name, () => fc.assert(fc.property(...arbs, fn)))`.
 *
 * Why a separate script: the multi-line regex approach in
 * `migrate-vitest-to-bun.ts` fails on nested `()` inside fn bodies. This one
 * counts brackets correctly.
 *
 * Run:
 *   bun scripts/migrate-fc-prop.ts            # dry-run
 *   bun scripts/migrate-fc-prop.ts --apply    # write
 */
import { readFileSync, writeFileSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')

function findMatchingClose(s: string, openIdx: number, open: string, close: string): number {
	let depth = 0
	let inString: '"' | "'" | '`' | null = null
	let inLineComment = false
	let inBlockComment = false
	for (let i = openIdx; i < s.length; i++) {
		const c = s[i]
		const prev = i > 0 ? s[i - 1] : ''
		if (inLineComment) {
			if (c === '\n') inLineComment = false
			continue
		}
		if (inBlockComment) {
			if (prev === '*' && c === '/') inBlockComment = false
			continue
		}
		if (inString) {
			if (c === '\\') {
				i++
				continue
			}
			if (c === inString) inString = null
			continue
		}
		if (c === '/' && i + 1 < s.length) {
			if (s[i + 1] === '/') {
				inLineComment = true
				i++
				continue
			}
			if (s[i + 1] === '*') {
				inBlockComment = true
				i++
				continue
			}
		}
		if (c === '"' || c === "'" || c === '`') {
			inString = c as '"' | "'" | '`'
			continue
		}
		if (c === open) depth++
		else if (c === close) {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

function findTopLevelComma(s: string): number {
	let depth = 0
	let inString: '"' | "'" | '`' | null = null
	for (let i = 0; i < s.length; i++) {
		const c = s[i]
		if (inString) {
			if (c === '\\') {
				i++
				continue
			}
			if (c === inString) inString = null
			continue
		}
		if (c === '"' || c === "'" || c === '`') {
			inString = c as '"' | "'" | '`'
			continue
		}
		if (c === '(' || c === '[' || c === '{') depth++
		else if (c === ')' || c === ']' || c === '}') depth--
		else if (c === ',' && depth === 0) return i
	}
	return -1
}

function rewrite(source: string): { next: string; count: number } {
	let result = ''
	let i = 0
	let count = 0
	const len = source.length
	// Match `<ident>.prop(` where ident is `test` or ends with `Test`.
	const re = /(?<![\w.$])(test|\w*Test)\.prop\(/g
	let lastEmitted = 0
	let m: RegExpExecArray | null
	re.lastIndex = 0
	while ((m = re.exec(source)) !== null) {
		const matchStart = m.index
		const propOpenIdx = m.index + m[0].length - 1 // index of `(`
		const propCloseIdx = findMatchingClose(source, propOpenIdx, '(', ')')
		if (propCloseIdx === -1) continue

		// Expect `[arbs]` inside.
		const propBody = source.slice(propOpenIdx + 1, propCloseIdx).trim()
		if (!propBody.startsWith('[') || !propBody.endsWith(']')) continue
		const arbs = propBody.slice(1, -1).trim()

		// After propCloseIdx should be `(name, fn)`.
		let nextStart = propCloseIdx + 1
		while (nextStart < len && /\s/.test(source[nextStart] ?? '')) nextStart++
		if (source[nextStart] !== '(') continue
		const callCloseIdx = findMatchingClose(source, nextStart, '(', ')')
		if (callCloseIdx === -1) continue

		const callBody = source.slice(nextStart + 1, callCloseIdx)
		const commaIdx = findTopLevelComma(callBody)
		if (commaIdx === -1) continue
		const testName = callBody.slice(0, commaIdx).trim()
		const fn = callBody
			.slice(commaIdx + 1)
			.trim()
			.replace(/,\s*$/, '')

		// Emit prefix up to match start.
		result += source.slice(lastEmitted, matchStart)
		result += `test(${testName}, () => { fc.assert(fc.property(${arbs}, ${fn})) })`
		lastEmitted = callCloseIdx + 1
		// Continue scanning past this replacement.
		re.lastIndex = callCloseIdx + 1
		count++
	}
	result += source.slice(lastEmitted)
	return { next: result, count }
}

const FILES = [
	'apps/backend/src/domains/booking/booking.service.test.ts',
	'apps/backend/src/domains/booking/booking.nights.test.ts',
	'apps/backend/src/domains/payment/lib/payment-transitions.test.ts',
	'apps/backend/src/domains/refund/lib/refund-math.test.ts',
	'apps/backend/src/domains/folio/lib/folio-balance.test.ts',
	'apps/backend/src/db/ydb-helpers.test.ts',
	'apps/backend/src/workers/cdc-handlers.test.ts',
	'apps/backend/src/domains/widget/widget-pricing.test.ts',
	'apps/frontend/src/features/public-widget/lib/addon-pricing.property.test.ts',
]

let totalCount = 0
for (const f of FILES) {
	const orig = readFileSync(f, 'utf8')
	let working = orig

	// 1. Rewrite imports first.
	working = working.replace(
		/import\s*\{\s*(?:fc\s*,\s*test|test\s*,\s*fc)(?:\s+as\s+\w+)?\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)
	working = working.replace(
		/import\s*\{\s*fc\s*,\s*test\s+as\s+\w+\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)
	working = working.replace(
		/import\s*\{\s*test\s+as\s+\w+\s*,\s*fc\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)
	working = working.replace(
		/import\s*\{\s*fc\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)
	working = working.replace(
		/import\s*\{\s*test\s+as\s+\w+\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		'',
	)
	// 2. Rewrite vitest imports too.
	working = working.replace(/from\s*['"]vitest['"]/g, "from 'bun:test'")
	// 3. Apply bracket-counter rewrite.
	const { next, count } = rewrite(working)
	working = next
	totalCount += count

	console.log(`  ${f}: ${count} prop calls rewritten`)
	if (APPLY) writeFileSync(f, working)
}
console.log(`\nTotal: ${totalCount} test.prop calls rewritten across ${FILES.length} files`)
console.log(APPLY ? '\n=== APPLIED ===' : '\n=== DRY RUN. Pass --apply to write. ===')
