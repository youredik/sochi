/**
 * Phase 16 cleanup — remove `test as <alias>` from bun:test imports.
 *
 * After `pbTest`/`fcTest` were rewritten to bare `test(...)`, the original
 * `import { test as vitestTest } from 'bun:test'` alias is now unused and
 * the bare `test` is undefined. Drop the alias.
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

let totalChanged = 0
for (const f of walk('apps').concat(walk('packages'))) {
	const orig = readFileSync(f, 'utf8')
	let next = orig
	// `import { ..., test as alias, ... } from 'bun:test'` — drop alias.
	next = next.replace(/(\bfrom\s*['"]bun:test['"])/g, (full) => full)
	next = next.replace(
		/(import\s*\{[^}]*?)\btest\s+as\s+\w+([^}]*\}\s*from\s*['"]bun:test['"])/g,
		'$1test$2',
	)
	if (next !== orig) {
		console.log(`  fix: ${f}`)
		totalChanged++
		if (APPLY) writeFileSync(f, next)
	}
}
console.log(`\nTotal: ${totalChanged} files unaliased.`)
console.log(APPLY ? '=== APPLIED ===' : '=== DRY RUN ===')
