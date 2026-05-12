#!/usr/bin/env node
// Empirical divergence checker between tsc (TS 6.0.3) and tsgo (TS 7
// native-preview). Runs both compilers on every tsconfig in the monorepo,
// parses diagnostics into normalized (file, line, col, code) tuples, and
// reports drift.
//
// Exit 0  — zero divergence.
// Exit 1  — at least one tsc-only or tsgo-only diagnostic.
// Exit 2  — internal error (parse, spawn).
//
// Wired into .github/workflows/post-push.yml as a shadow informational
// step (continue-on-error: true). Data accrues over time on real main
// pushes. Gate flip threshold: 0 divergence on 10+ consecutive main pushes
// AND TS 7 GA reached (ratchet-check.sh swap to tsgo).
//
// See project_tsgo_pilot_2026_05_12.md for pilot baseline.

import { spawnSync } from 'node:child_process'

interface Diag {
	file: string
	line: number
	col: number
	code: string
}

interface Project {
	name: string
	tsconfig: string
}

const PROJECTS: Project[] = [
	{ name: 'backend', tsconfig: 'apps/backend/tsconfig.json' },
	{ name: 'frontend', tsconfig: 'apps/frontend/tsconfig.json' },
	{ name: 'widget', tsconfig: 'apps/widget-embed/tsconfig.json' },
	{ name: 'shared', tsconfig: 'packages/shared/tsconfig.json' },
]

// Both compilers emit non-pretty (no TTY) format when stdout is captured:
//   path/to/file.ts(123,45): error TS2345: Argument of type ...
// Defensive: also match pretty format (rare in CI):
//   path/to/file.ts:123:45 - error TS2345: ...
const ERR_RE_PAREN = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+)/gm
const ERR_RE_COLON = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+)/gm

function parse(out: string): Diag[] {
	const diags: Diag[] = []
	for (const m of out.matchAll(ERR_RE_PAREN)) {
		diags.push({ file: m[1], line: +m[2], col: +m[3], code: m[4] })
	}
	for (const m of out.matchAll(ERR_RE_COLON)) {
		diags.push({ file: m[1], line: +m[2], col: +m[3], code: m[4] })
	}
	return diags
}

function runCompiler(bin: 'tsc' | 'tsgo', tsconfig: string): string {
	const r = spawnSync('pnpm', ['exec', bin, '--noEmit', '-p', tsconfig], {
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024,
	})
	if (r.error) {
		process.stderr.write(`[tsgo-diff] spawn failed for ${bin}: ${r.error.message}\n`)
		process.exit(2)
	}
	return (r.stdout ?? '') + (r.stderr ?? '')
}

function key(d: Diag): string {
	return `${d.file}:${d.line}:${d.col}:${d.code}`
}

const tscAll: Diag[] = []
const tsgoAll: Diag[] = []

for (const p of PROJECTS) {
	process.stderr.write(`[tsgo-diff] ${p.name}: tsc...\n`)
	tscAll.push(...parse(runCompiler('tsc', p.tsconfig)))
	process.stderr.write(`[tsgo-diff] ${p.name}: tsgo...\n`)
	tsgoAll.push(...parse(runCompiler('tsgo', p.tsconfig)))
}

const tscSet = new Set(tscAll.map(key))
const tsgoSet = new Set(tsgoAll.map(key))

const tscOnly = [...tscSet].filter((k) => !tsgoSet.has(k)).sort()
const tsgoOnly = [...tsgoSet].filter((k) => !tscSet.has(k)).sort()

console.log(`tsc diagnostics:  ${tscSet.size}`)
console.log(`tsgo diagnostics: ${tsgoSet.size}`)

if (tscOnly.length === 0 && tsgoOnly.length === 0) {
	console.log('[OK] tsc/tsgo parity: 0 divergence')
	process.exit(0)
}

const LIMIT = 30
if (tscOnly.length > 0) {
	console.log(`\n[FAIL] tsc-only (${tscOnly.length} — tsgo silently passed):`)
	tscOnly.slice(0, LIMIT).forEach((k) => console.log(`  - ${k}`))
	if (tscOnly.length > LIMIT) console.log(`  ... +${tscOnly.length - LIMIT} more`)
}
if (tsgoOnly.length > 0) {
	console.log(`\n[FAIL] tsgo-only (${tsgoOnly.length} — tsgo stricter than tsc):`)
	tsgoOnly.slice(0, LIMIT).forEach((k) => console.log(`  + ${k}`))
	if (tsgoOnly.length > LIMIT) console.log(`  ... +${tsgoOnly.length - LIMIT} more`)
}
console.log('\nSee project_tsgo_pilot_2026_05_12.md for context.')
process.exit(1)
