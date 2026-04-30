#!/usr/bin/env node
/**
 * `pnpm doctor` — fail-fast pre-flight check для local dev environment.
 *
 * Per `feedback_no_disrupt_other_dev.md`: sochi shares localhost с другими
 * dev sessions (stankoff-v2 etc.). До запуска test/E2E gates проверяем что
 * наши порты либо свободны, либо принадлежат sochi (cwd-based ownership).
 * Зеро ambiguity, fail-fast с человеческим сообщением.
 *
 * Используется:
 *   - lefthook pre-push hook (FIRST gate, ~5 секунд) — ловит конфликт ДО
 *     5-минутного e2e:smoke
 *   - manual `pnpm doctor` после restart laptop / странного поведения
 *
 * Exit codes:
 *   0 — всё OK
 *   1 — port conflict (другой проект держит наш port)
 *   2 — service marker mismatch (sochi backend running но возвращает чужой
 *       /health body — невозможный case, но guard'имся)
 */

import { execSync } from 'node:child_process'

const SOCHI_BACKEND_PORT = 8787
const SOCHI_FRONTEND_PORT = 5273
const SOCHI_HEALTH_MARKER = 'sochi-horeca'

interface PortOwnership {
	port: number
	pid: number | null
	cwd: string | null
}

function lsofPid(port: number): number | null {
	try {
		const out = execSync(`lsof -ti :${port} -sTCP:LISTEN 2>/dev/null`, { encoding: 'utf8' })
		const pid = Number.parseInt(out.trim().split('\n')[0] ?? '', 10)
		return Number.isFinite(pid) ? pid : null
	} catch {
		return null
	}
}

function pidCwd(pid: number): string | null {
	try {
		const out = execSync(`lsof -p ${pid} 2>/dev/null | awk '$4=="cwd" {print $NF}'`, {
			encoding: 'utf8',
		})
		return out.trim() || null
	} catch {
		return null
	}
}

function checkPort(port: number): PortOwnership {
	const pid = lsofPid(port)
	if (pid === null) return { port, pid: null, cwd: null }
	const cwd = pidCwd(pid)
	return { port, pid, cwd }
}

function isSochiCwd(cwd: string | null): boolean {
	if (!cwd) return false
	return cwd.includes('/dev/sochi')
}

async function fetchHealthMarker(port: number): Promise<string | null> {
	try {
		const res = await fetch(`http://localhost:${port}/health`, {
			signal: AbortSignal.timeout(2000),
		})
		if (!res.ok) return null
		const body = (await res.json()) as { service?: string }
		return body.service ?? null
	} catch {
		return null
	}
}

async function main(): Promise<number> {
	const issues: string[] = []
	const info: string[] = []

	for (const port of [SOCHI_BACKEND_PORT, SOCHI_FRONTEND_PORT]) {
		const own = checkPort(port)
		if (own.pid === null) {
			info.push(`✓ port ${port} free (pre-push hook will spawn)`)
			continue
		}
		if (isSochiCwd(own.cwd)) {
			info.push(`✓ port ${port} held by sochi (PID ${own.pid}, cwd=${own.cwd})`)
			continue
		}
		issues.push(
			`✗ port ${port} held by NON-sochi process — PID ${own.pid}, cwd=${own.cwd ?? 'unknown'}\n` +
				`    Stop the conflicting dev session OR change sochi port allocation.`,
		)
	}

	// If sochi backend running, verify health marker
	const beOwn = checkPort(SOCHI_BACKEND_PORT)
	if (beOwn.pid !== null && isSochiCwd(beOwn.cwd)) {
		const marker = await fetchHealthMarker(SOCHI_BACKEND_PORT)
		if (marker === SOCHI_HEALTH_MARKER) {
			info.push(`✓ /health marker = "${marker}" (port ${SOCHI_BACKEND_PORT})`)
		} else if (marker === null) {
			info.push(`~ /health unreachable on ${SOCHI_BACKEND_PORT} (backend may still be booting)`)
		} else {
			issues.push(
				`✗ /health marker mismatch on port ${SOCHI_BACKEND_PORT}: got "${marker}", expected "${SOCHI_HEALTH_MARKER}".\n` +
					`    Wrong project running on our port.`,
			)
			return 2
		}
	}

	console.log(info.join('\n'))
	if (issues.length > 0) {
		console.error(`\n${issues.join('\n\n')}`)
		console.error(
			'\nSee `feedback_no_disrupt_other_dev.md` (sochi backend=8787, frontend=5273).',
		)
		return 1
	}
	console.log('\n✓ dev-doctor: all clear')
	return 0
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error('dev-doctor crashed:', err)
		process.exit(3)
	},
)
