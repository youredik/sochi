/**
 * Phase 16 — strip `describe(label, { options }, fn)` 3rd-arg → `describe(label, fn)`.
 *
 * bun:test (per bun.com/reference/bun/test verified 2026-05-13) supports ONLY
 * `describe(label, fn)`. Vitest's `{ tags, timeout }` 3rd-arg deprecated.
 *
 * - tags → file naming convention (already migrated к *.db.test.ts)
 * - timeout → `setDefaultTimeout(60_000)` at file-top OR per-test
 *
 * Bracket-counter (no regex multi-line hazard).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const SKIP = new Set(['node_modules', 'dist', '.git', '.stryker-tmp'])

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (SKIP.has(e)) continue
		const full = join(dir, e)
		if (statSync(full).isDirectory()) walk(full, out)
		else if (/\.test\.tsx?$/.test(e)) out.push(full)
	}
	return out
}

function findMatchingClose(s: string, openIdx: number, open: string, close: string): number {
	let depth = 0
	let inString: '"' | "'" | '`' | null = null
	for (let i = openIdx; i < s.length; i++) {
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
		if (c === open) depth++
		else if (c === close) {
			depth--
			if (depth === 0) return i
		}
	}
	return -1
}

function findTopLevelComma(s: string): number[] {
	const out: number[] = []
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
		else if (c === ',' && depth === 0) out.push(i)
	}
	return out
}

function rewrite(source: string): { next: string; count: number } {
	let result = ''
	let count = 0
	const re = /\bdescribe\(/g
	let lastEmitted = 0
	let m: RegExpExecArray | null
	while ((m = re.exec(source)) !== null) {
		const openIdx = m.index + m[0].length - 1
		const closeIdx = findMatchingClose(source, openIdx, '(', ')')
		if (closeIdx === -1) continue
		const body = source.slice(openIdx + 1, closeIdx)
		const commas = findTopLevelComma(body)
		if (commas.length !== 2) continue // we want exactly 3 args
		const arg1 = body.slice(0, commas[0]).trim()
		const arg2 = body.slice(commas[0] + 1, commas[1]).trim()
		const arg3 = body.slice(commas[1] + 1).trim()
		// arg2 should be `{ ... }` object literal
		if (!arg2.startsWith('{') || !arg2.endsWith('}')) continue
		// arg3 should be a function (arrow OR async)
		if (!arg3.includes('=>') && !arg3.startsWith('async') && !arg3.startsWith('function')) continue
		result += source.slice(lastEmitted, m.index)
		result += `describe(${arg1}, ${arg3})`
		lastEmitted = closeIdx + 1
		re.lastIndex = closeIdx + 1
		count++
	}
	result += source.slice(lastEmitted)
	return { next: result, count }
}

let total = 0
for (const f of walk('apps').concat(walk('packages'))) {
	const orig = readFileSync(f, 'utf8')
	const { next, count } = rewrite(orig)
	if (count > 0) {
		console.log(`  ${f}: ${count}`)
		total += count
		if (APPLY) writeFileSync(f, next)
	}
}
console.log(`\nTotal: ${total} describe-3-arg calls stripped`)
console.log(APPLY ? '=== APPLIED ===' : '=== DRY RUN. --apply ===')
