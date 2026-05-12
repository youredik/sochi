#!/usr/bin/env node
// Empirical sweep: runs tsgo/tsc divergence check across N recent commits
// from origin/main. Replaces the «wait N+ PRs for shadow CI data» gate
// with same-session empirical evidence.
//
// Why this exists:
// Phase 5 (`5b4bdf6`) made the post-push diff-runner BLOCKING. The intended
// audit trail accrued data only on FUTURE main pushes — calendar-bound.
// Sweep proves parity TODAY against the actual historical evolution of
// our code (last N commits before the migration branched off).
//
// Usage:
//   pnpm tsgo:sweep            # default: last 20 commits on origin/main
//   pnpm tsgo:sweep 30         # custom count
//
// Exits 0 if all commits show tsc/tsgo parity, 1 if any divergence.
// Always restores HEAD to the starting branch via try/finally.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const COMMITS = Number(process.argv[2] ?? 20);

// Direct binary paths — current node_modules, NOT the historical commit's
// node_modules. This is intentional: we test the CURRENT pair of compilers
// against historical code states. Dep churn within last N commits is
// minimal; if a historical commit doesn't compile under current deps,
// BOTH compilers fail equally → no divergence → still informative.
const TSC = resolve("node_modules/.bin/tsc");
const TSGO = resolve("node_modules/.bin/tsgo");

interface Project {
	name: string;
	tsconfig: string;
}
const PROJECTS: Project[] = [
	{ name: "backend", tsconfig: "apps/backend/tsconfig.json" },
	{ name: "frontend", tsconfig: "apps/frontend/tsconfig.json" },
	{ name: "widget", tsconfig: "apps/widget-embed/tsconfig.json" },
	{ name: "shared", tsconfig: "packages/shared/tsconfig.json" },
];

const ERR_RE_PAREN = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+)/gm;
const ERR_RE_COLON = /^(.+?):(\d+):(\d+)\s+-\s+error\s+(TS\d+)/gm;

interface Diag {
	file: string;
	line: number;
	col: number;
	code: string;
}

function parse(out: string): Set<string> {
	const set = new Set<string>();
	for (const m of out.matchAll(ERR_RE_PAREN)) set.add(`${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
	for (const m of out.matchAll(ERR_RE_COLON)) set.add(`${m[1]}:${m[2]}:${m[3]}:${m[4]}`);
	return set;
}

function git(args: string[]): string {
	const r = spawnSync("git", args, { encoding: "utf8" });
	if (r.status !== 0) {
		process.stderr.write(`[sweep] git ${args.join(" ")} failed:\n${r.stderr}\n`);
		process.exit(2);
	}
	return (r.stdout ?? "").trim();
}

function runCompiler(bin: string, tsconfig: string): string {
	const r = spawnSync(bin, ["--noEmit", "-p", tsconfig], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return (r.stdout ?? "") + (r.stderr ?? "");
}

function compareAtHead(): { tscOnly: number; tsgoOnly: number; tscTotal: number; tsgoTotal: number } {
	const tsc = new Set<string>();
	const tsgo = new Set<string>();
	for (const p of PROJECTS) {
		for (const k of parse(runCompiler(TSC, p.tsconfig))) tsc.add(k);
		for (const k of parse(runCompiler(TSGO, p.tsconfig))) tsgo.add(k);
	}
	let tscOnly = 0;
	let tsgoOnly = 0;
	for (const k of tsc) if (!tsgo.has(k)) tscOnly++;
	for (const k of tsgo) if (!tsc.has(k)) tsgoOnly++;
	return { tscOnly, tsgoOnly, tscTotal: tsc.size, tsgoTotal: tsgo.size };
}

const initialBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (initialBranch === "HEAD") {
	process.stderr.write("[sweep] Detached HEAD — refuse to sweep, would not restore cleanly.\n");
	process.exit(2);
}
if (git(["status", "--porcelain"]).length > 0) {
	process.stderr.write("[sweep] Working tree dirty — commit or stash before sweep.\n");
	process.exit(2);
}

const shas = git(["log", "--format=%H", "-n", String(COMMITS), "origin/main"])
	.split("\n")
	.filter(Boolean);

console.log(`[sweep] Testing tsc/tsgo parity over ${shas.length} commits (origin/main).`);
console.log(`[sweep] Compilers: ${TSC} + ${TSGO}`);
console.log(`[sweep] Starting branch: ${initialBranch}`);
console.log("");

interface Row {
	sha: string;
	subject: string;
	tscOnly: number;
	tsgoOnly: number;
	tscTotal: number;
	tsgoTotal: number;
}
const rows: Row[] = [];

try {
	for (let i = 0; i < shas.length; i++) {
		const sha = shas[i];
		const subject = git(["log", "--format=%s", "-n", "1", sha]).slice(0, 70);
		spawnSync("git", ["checkout", "--quiet", sha], { stdio: "inherit" });
		const r = compareAtHead();
		rows.push({ sha: sha.slice(0, 7), subject, ...r });
		const verdict = r.tscOnly === 0 && r.tsgoOnly === 0 ? "[OK]" : "[DRIFT]";
		console.log(
			`${verdict} ${(i + 1).toString().padStart(2)}/${shas.length} ${sha.slice(0, 7)}  tsc=${r.tscTotal} tsgo=${r.tsgoTotal} tscOnly=${r.tscOnly} tsgoOnly=${r.tsgoOnly}  — ${subject}`,
		);
	}
} finally {
	console.log("");
	console.log(`[sweep] Restoring HEAD to ${initialBranch}...`);
	spawnSync("git", ["checkout", "--quiet", initialBranch], { stdio: "inherit" });
}

const drifts = rows.filter((r) => r.tscOnly > 0 || r.tsgoOnly > 0);
console.log("");
console.log(`Summary: ${rows.length} commits, ${drifts.length} with drift.`);
if (drifts.length === 0) {
	console.log("[OK] tsc/tsgo parity confirmed across full sampled history.");
	process.exit(0);
}
console.log("[FAIL] Drifting commits:");
for (const d of drifts) {
	console.log(`  ${d.sha} tscOnly=${d.tscOnly} tsgoOnly=${d.tsgoOnly} — ${d.subject}`);
}
process.exit(1);
