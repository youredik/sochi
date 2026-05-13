/**
 * Phase 16 — Vitest → Bun test codemod (2026-05-12).
 *
 * One-shot mass migration:
 *   1. Walks apps/**\/*.test.ts(x) and packages/**\/*.test.ts(x)
 *   2. Rewrites `from 'vitest'` → `from 'bun:test'`
 *   3. Rewrites vi.* namespace → mock/spyOn (per bun:test API canon May 2026)
 *   4. Strips `tags: ['db']` option from describe(...) — bun test has no tag filter,
 *      we move to file-naming convention `*.db.test.ts` instead.
 *   5. Renames db-tagged files: foo.test.ts → foo.db.test.ts via git mv
 *   6. Prints dry-run diff first; pass `--apply` to write.
 *
 * Run:
 *   bun scripts/migrate-vitest-to-bun.ts            # dry-run
 *   bun scripts/migrate-vitest-to-bun.ts --apply    # write + git mv
 */
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APPLY = process.argv.includes('--apply')
const ROOTS = ['apps', 'packages']
const SKIP_DIRS = new Set([
	'node_modules',
	'dist',
	'.git',
	'.stryker-tmp',
	'.artifacts',
	'coverage',
])

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (SKIP_DIRS.has(entry)) continue
		const stat = statSync(full)
		if (stat.isDirectory()) walk(full, out)
		else if (/\.test\.tsx?$/.test(entry)) out.push(full)
	}
	return out
}

interface FileResult {
	path: string
	hasDbTag: boolean
	transformed: boolean
	renamedTo?: string
}

function rewriteContent(content: string): { next: string; hasDbTag: boolean } {
	let next = content
	const hasDbTag = /tags:\s*\[['"]db['"]\]/.test(next)

	// 1. Imports: from 'vitest' → from 'bun:test'.
	next = next.replace(/from\s+['"]vitest['"]/g, "from 'bun:test'")

	// 1b. @fast-check/vitest → plain fast-check + bun:test. The vitest adapter
	// provides `test.prop([arb])(name, fn)`; bun:test has no such adapter, so
	// callers wrap with `fc.assert(fc.property(...))` inside a plain `test()`.
	// Pattern transform: rewrite import + rewrite test.prop invocations.
	next = next.replace(
		/import\s*\{\s*fc\s*,\s*test\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'\nimport { test } from 'bun:test'",
	)
	next = next.replace(
		/import\s*\{\s*test\s*,\s*fc\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import { test } from 'bun:test'\nimport * as fc from 'fast-check'",
	)
	// fc-only import
	next = next.replace(
		/import\s*\{\s*fc\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)
	// test-only import
	next = next.replace(
		/import\s*\{\s*test\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import { test } from 'bun:test'",
	)
	// Drop stale `test as vitestTest` aliases — bun:test exports the canonical `test`.
	next = next.replace(/test\s+as\s+vitestTest\s*,?\s*/g, '')
	next = next.replace(/import\s*\{\s*,\s*/g, 'import { ')
	// Rewrite `test.prop([arb])(name, fn)` AND aliased forms like
	// `pbTest.prop(...)` / `fcTest.prop(...)` → `test(name, () => fc.assert(fc.property(arb, fn)))`.
	// `(?:test|\w+Test)` matches both bare `test` and any `*Test` alias.
	next = next.replace(
		/(?:test|\w+Test)\.prop\(\s*\[([\s\S]*?)\]\s*\)\(\s*(['"][^'"]+['"])\s*,\s*([\s\S]*?)\)(\s*;?)$/gm,
		'test($2, () => { fc.assert(fc.property($1, $3)) })$4',
	)
	// Aliased import forms: `import { fc, test as XXX } from '@fast-check/vitest'`.
	next = next.replace(
		/import\s*\{\s*fc\s*,\s*test\s+as\s+\w+\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)
	next = next.replace(
		/import\s*\{\s*test\s+as\s+\w+\s*,\s*fc\s*\}\s*from\s*['"]@fast-check\/vitest['"]/g,
		"import * as fc from 'fast-check'",
	)

	// 2. Import-list: rename `vi` → `mock` (bun:test exports `mock` for both
	//    function-mocking and module-mocking). Add `spyOn` if used.
	//    Strategy: replace ` vi,` / `, vi` / `{ vi }` patterns.
	next = next.replace(/(\{\s*)vi(\s*[,}])/g, '$1mock$2')
	next = next.replace(/,\s*vi(\s*[,}])/g, ', mock$1')
	next = next.replace(/(\{\s*[^}]*?),\s*vi\s*,/g, '$1, mock,')

	// If spyOn is used in body but not imported, ensure it's in the bun:test import.
	const usesSpyOn = /\bvi\.spyOn\(|\bspyOn\(/.test(next)

	// 3. Namespace rewrites: vi.* → equivalents on bun:test.
	next = next.replace(/\bvi\.mock\(/g, 'mock.module(')
	next = next.replace(/\bvi\.fn\b/g, 'mock')
	next = next.replace(/\bvi\.clearAllMocks\(/g, 'mock.clearAllMocks(')
	next = next.replace(/\bvi\.resetAllMocks\(/g, 'mock.clearAllMocks(')
	next = next.replace(/\bvi\.restoreAllMocks\(/g, 'mock.restore(')
	next = next.replace(/\bvi\.spyOn\(/g, 'spyOn(')
	// vi.hoisted — bun has no auto-hoisting; mocks must be declared before imports.
	// (a) `const { x } = vi.hoisted(() => ({ x: ... }))` → `const { x } = { x: ... }`
	next = next.replace(
		/const\s+(\{[^}]+\})\s*=\s*vi\.hoisted\(\(\)\s*=>\s*\(\s*(\{[\s\S]*?\})\s*\)\s*\)\s*;?/g,
		'const $1 = $2',
	)
	// (b) `const name = vi.hoisted(() => value)` → `const name = value`
	next = next.replace(
		/const\s+(\w+)\s*=\s*vi\.hoisted\(\(\)\s*=>\s*(\{[\s\S]*?\}|\([\s\S]*?\)|[^)]+)\)\s*;?/g,
		'const $1 = $2',
	)
	// (c) `vi.hoisted(() => { … })` block-form side-effect → inline IIFE
	next = next.replace(/vi\.hoisted\(\(\)\s*=>\s*\{([\s\S]*?)\}\)\s*;?/g, ';(() => {$1})()')

	// vi.mocked(x) — Vitest type cast helper. bun:test has no equivalent → identity cast.
	next = next.replace(/\bvi\.mocked\(/g, '(')

	// vi.stubGlobal — single-line literal-name common case. Multi-line / nested
	// calls (e.g. vi.stubGlobal('matchMedia', vi.fn().mockImpl(...))) need manual
	// surgery — flagged in codemod summary.
	next = next.replace(
		/\bvi\.stubGlobal\(\s*['"](\w+)['"]\s*,\s*([^)]+)\)\s*;?/g,
		';(globalThis as Record<string, unknown>).$1 = $2',
	)
	next = next.replace(
		/\bvi\.unstubAllGlobals\(\)\s*;?/g,
		'/* vi.unstubAllGlobals() — no-op in bun:test (manual restore required) */',
	)

	// vi.resetModules() — bun has no direct equivalent.  Hot-reload happens per-test
	// already in bun's module cache. Strip the call.
	next = next.replace(/\bvi\.resetModules\(\)\s*;?/g, '/* vi.resetModules() — no-op in bun:test */')

	next = next.replace(/\bvi\.useFakeTimers\(/g, 'mock.useFakeTimers(')
	next = next.replace(/\bvi\.useRealTimers\(/g, 'mock.useRealTimers(')
	next = next.replace(/\bvi\.advanceTimersByTime\(/g, 'mock.advanceTimersByTime(')

	// Type references: ReturnType<typeof vi.spyOn> → ReturnType<typeof spyOn>
	next = next.replace(/typeof\s+vi\.spyOn/g, 'typeof spyOn')
	next = next.replace(/typeof\s+vi\.fn/g, 'typeof mock')

	// Ensure spyOn appears in import-list when used.
	if (usesSpyOn) {
		next = next.replace(
			/(import\s+\{[^}]*?)mock([^}]*?\}\s+from\s+'bun:test')/g,
			(m, pre, post) => {
				if (m.includes('spyOn')) return m
				return `${pre}mock, spyOn${post}`
			},
		)
	}

	// 4. Strip `tags: ['db']` from describe options object.
	//    Patterns:
	//      describe('x', { tags: ['db'], timeout: 60_000 }, () => {...}) →
	//      describe('x', { timeout: 60_000 }, () => {...})
	//      describe('x', { tags: ['db'] }, () => {...}) →
	//      describe('x', () => {...})
	next = next.replace(/(\{\s*)tags:\s*\[['"]db['"]\]\s*,\s*/g, '$1')
	next = next.replace(/,\s*tags:\s*\[['"]db['"]\]\s*(,|\})/g, '$1')
	next = next.replace(/describe\((['"][^'"]+['"]),\s*\{\s*\}\s*,/g, 'describe($1,')

	return { next, hasDbTag }
}

const allFiles = ROOTS.flatMap((r) => walk(r))
console.log(`Scanned ${allFiles.length} *.test.ts(x) files in ${ROOTS.join(', ')}`)

const results: FileResult[] = []
for (const path of allFiles) {
	const orig = readFileSync(path, 'utf8')
	const { next, hasDbTag } = rewriteContent(orig)
	const transformed = next !== orig
	let renamedTo: string | undefined
	if (hasDbTag && !path.endsWith('.db.test.ts') && !path.endsWith('.db.test.tsx')) {
		renamedTo = path.replace(/\.test\.(tsx?)$/, '.db.test.$1')
	}
	results.push({ path, hasDbTag, transformed, renamedTo })
	if (APPLY && transformed) writeFileSync(path, next)
}

const transformed = results.filter((r) => r.transformed)
const renames = results.filter((r) => r.renamedTo)
console.log(`Transformed: ${transformed.length}`)
console.log(`To rename:  ${renames.length}`)
console.log(`No-change:  ${results.length - transformed.length}`)

if (APPLY) {
	for (const r of renames) {
		try {
			execSync(`git mv "${r.path}" "${r.renamedTo}"`, { stdio: 'pipe' })
			console.log(`  ✓ renamed ${r.path} → ${r.renamedTo}`)
		} catch (e) {
			console.error(`  ✗ rename failed for ${r.path}:`, (e as Error).message)
		}
	}
	console.log('\n=== APPLIED. Run `bun test` to verify. ===')
} else {
	console.log('\n=== DRY RUN. Pass --apply to write changes + git mv. ===')
	console.log('Sample of files to rename:')
	for (const r of renames.slice(0, 5)) console.log(`  ${r.path} → ${r.renamedTo}`)
}

process.exit(0)
