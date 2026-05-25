/** @type {import('dependency-cruiser').IConfiguration} */
export default {
	extends: 'dependency-cruiser/configs/recommended-strict',
	forbidden: [
		// === Backend DAG: routes → service → repo → db ===
		{
			name: 'no-routes-to-db',
			comment: 'Route handlers must go through service → repo, not access db/ directly.',
			severity: 'error',
			from: { path: 'domains/.+\\.routes\\.ts$' },
			to: { path: '^apps/backend/src/db/' },
		},
		{
			name: 'no-service-to-routes',
			comment: 'Services must not know about HTTP routes.',
			severity: 'error',
			from: { path: 'domains/.+\\.service\\.ts$' },
			to: { path: 'domains/.+\\.routes\\.ts$' },
		},
		{
			name: 'no-repo-to-service-or-routes',
			comment: 'Repos are data access only.',
			severity: 'error',
			from: { path: 'domains/.+\\.repo\\.ts$' },
			to: { path: 'domains/.+\\.(service|routes)\\.ts$' },
		},

		// === Domain isolation ===
		// Domains must not import RUNTIME code from each other. Type-only imports
		// are allowed for the parent-service DI pattern (room.service imports
		// `type { RoomTypeService }` to receive an injected instance via factory),
		// so `dependencyTypesNot: ['type-only']` excludes them. Runtime
		// cross-domain imports still fail this rule with an error.
		//
		// `*.integration.test.ts` AND `*.integration.db.test.ts` files are exempted
		// because integration tests legitimately orchestrate factories from
		// multiple domains to prove end-to-end behavior (e.g. booking.service
		// creating a reservation requires property + roomType + ratePlan + rate
		// + availability factories to be wired). Production code is still locked in.
		{
			name: 'no-cross-domain',
			comment:
				'Domains must not import runtime code from other domains — use type-only imports for DI wiring. Integration tests (*.integration.{db.,}test.ts) are exempted. `_demo/` is exempted per Round 9 canon — see `allow-demo-imports-production` rule.',
			severity: 'error',
			from: {
				path: '^apps/backend/src/domains/([^/]+)/',
				pathNot: '(\\.integration\\.(db\\.)?test\\.ts$|^apps/backend/src/domains/_demo/)',
			},
			to: {
				path: '^apps/backend/src/domains/([^/]+)/',
				pathNot: '^apps/backend/src/domains/$1/',
				dependencyTypesNot: ['type-only'],
			},
		},

		// === Round 9 demo isolation (canon: feedback_round_9_demo_ota_server_canon_2026_05_25) ===
		//
		// Hexagonal Ports-and-Adapters: `_demo/` is a special-purpose folder that
		// LEGITIMATELY imports production code (interfaces, Mock factories, lib helpers)
		// to HTTP-wrap them for sales-demo wow-effect. The boundary is **one-way**:
		// production code MUST NEVER import from `_demo/` (lint-enforced below).
		//
		// Exit ramps for future Phase 2+: when `_demo/` graduates to its own deploy
		// unit, just `mv apps/backend/src/domains/_demo apps/mock-ota/src/` — the
		// folder structure mirrors a standalone app already.
		{
			name: 'forbid-production-to-demo',
			comment:
				'Production code MUST NEVER import from _demo/. The boundary is one-way per Round 9 canon. If you need shared logic, refactor it to `lib/` instead. Exemption: `app.ts` is the wiring root and may call `registerDemoRoutes()` env-gated; mounting is the only allowed cross-boundary contact.',
			severity: 'error',
			from: {
				path: '^apps/backend/src/',
				pathNot: '(^apps/backend/src/domains/_demo/|^apps/backend/src/app\\.ts$)',
			},
			to: { path: '^apps/backend/src/domains/_demo/' },
		},

		// === Middleware isolation ===
		{
			name: 'no-middleware-to-domains',
			comment: 'Middleware must be domain-agnostic.',
			severity: 'error',
			from: { path: '^apps/backend/src/middleware/' },
			to: { path: '^apps/backend/src/domains/' },
		},

		// === Package boundaries ===
		{
			name: 'no-shared-to-apps',
			comment: 'Shared package must not depend on app code.',
			severity: 'error',
			from: { path: '^packages/shared/src/' },
			to: { path: '^apps/' },
		},
		{
			name: 'no-frontend-to-backend-src',
			comment: 'Frontend must not import backend source files (type-only AppType is allowed).',
			severity: 'error',
			from: { path: '^apps/frontend/src/' },
			to: {
				path: '^apps/backend/src/',
				pathNot: '\\.d\\.ts$',
				dependencyTypesNot: ['type-only'],
			},
		},
		{
			name: 'no-backend-to-frontend',
			comment: 'Backend must never import from frontend.',
			severity: 'error',
			from: { path: '^apps/backend/src/' },
			to: { path: '^apps/frontend/' },
		},

		// === Preset overrides ===
		{
			name: 'not-to-unresolvable',
			comment: 'Excludes @/* tsconfig path aliases (covered by Biome noUnresolvedImports).',
			severity: 'error',
			from: {},
			to: { couldNotResolve: true, pathNot: ['^@/', '^virtual:'] },
		},
		{
			name: 'no-orphans',
			comment: 'Frontend excluded: @/* aliases unresolvable by dep-cruiser.',
			severity: 'error',
			from: {
				orphan: true,
				pathNot: [
					'\\.(test|spec|test-d)\\.ts$',
					'\\.gen\\.ts$',
					'(^|/)vite\\.config\\.ts$',
					'^apps/frontend/',
					'apps/backend/src/index\\.ts$',
					// Vitest setupFile (referenced from vitest.config.ts setupFiles
					// only — no direct import).
					'apps/backend/src/tests/env-defaults\\.ts$',
					// Phase 16 Bun + tsgo migration empirical evidence — standalone
					// benchmark/spike scripts run via `bun run`. Not imported by
					// production code; their purpose is one-off measurement.
					'apps/backend/src/db/(bench-schema-prefix|spike-bun-ydb)\\.ts$',
				],
			},
			to: {},
		},
		// Sprint C+ Round 7 2026-05-24 — `no-duplicate-dep-types` (inherited from
		// `recommended-strict`) flags zod canary 4.5.0 dual package shape: both
		// `index.d.cts` (CJS) and `index.d.ts` (ESM) resolve to the SAME module,
		// dep-cruiser reports it as «duplicate type imports». That's a property
		// of zod's npm package layout, NOT codebase mis-import. 74 false-positive
		// errors after Stagehand→langsmith→zod-canary transitive landed.
		//
		// Canonical fix per dep-cruiser docs: downgrade severity к 'ignore' or
		// scope rule. Choose 'ignore' — the rule has zero value when entire
		// ecosystem is mid-flight к hybrid CJS/ESM packages (every major lib
		// will trip this when shipping dual types).
		{
			name: 'no-duplicate-dep-types',
			comment:
				'OVERRIDE from recommended-strict preset (2026-05-24): zod canary 4.5.0 dual ' +
				'package shape (.d.cts + .d.ts) trips this rule for ALL zod imports. False-positive ' +
				'for hybrid CJS/ESM npm packages — rule has no value в 2026 ecosystem state.',
			severity: 'ignore',
			from: {},
			to: { moreThanOneDependencyType: true },
		},
	],
	options: {
		tsConfig: { fileName: 'tsconfig.base.json' },
		tsPreCompilationDeps: true,
		combinedDependencies: true,
		doNotFollow: { path: 'node_modules' },
		// `(^|/)dist/`     — built output, not source.
		// `\\.stryker-tmp` — Stryker mutation-testing sandbox (untracked,
		//   gitignored). Without exclusion every `pnpm mutate` leaves a
		//   full copy of `apps/backend/src/` that depcruise then double-
		//   counts as orphan modules. Same bug as ratchet weak_assertions.
		exclude: { path: '(^|/)dist/|\\.stryker-tmp' },
		enhancedResolveOptions: {
			exportsFields: ['exports'],
			conditionNames: ['import', 'require', 'node', 'default', 'types'],
			mainFields: ['main', 'module', 'types', 'typings'],
			extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
		},
		reporterOptions: {
			text: { highlightFocused: true },
		},
	},
}
