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
				'Domains must not import runtime code from other domains — use type-only imports for DI wiring. Integration tests (*.integration.{db.,}test.ts) are exempted.',
			severity: 'error',
			from: {
				path: '^apps/backend/src/domains/([^/]+)/',
				pathNot: '\\.integration\\.(db\\.)?test\\.ts$',
			},
			to: {
				path: '^apps/backend/src/domains/([^/]+)/',
				pathNot: '^apps/backend/src/domains/$1/',
				dependencyTypesNot: ['type-only'],
			},
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
