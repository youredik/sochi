# `_demo/` — Sales-demo mock-OTA layer

**Canon**: `memory/feedback_round_9_demo_ota_server_canon_2026_05_25.md`
**Status**: Phase-1 (built 2026-05-25)
**Owner**: Sepshn architecture

---

## What this is

This folder hosts the **standalone mock-OTA servers** that emulate Yandex.Путешествия + Островок for sales-demo wow-effect. When a "guest" books on a demo-OTA page, the booking flows through our real channel inbox into the PMS exactly as it would from a live OTA.

It is **not production code**. It is a special-purpose folder with strict boundaries.

## Architecture — one-way dependency

```
        ┌─────────────────────┐
        │   _demo/            │  ← can import from anywhere below
        │   (mock-ota server) │
        └──────────┬──────────┘
                   │ imports
                   ▼
        ┌─────────────────────┐
        │   domains/channel/  │
        │   lib/              │  ← canonical interfaces
        │   middleware/       │
        └─────────────────────┘
                   ✗
        (production NEVER imports from _demo/)
```

**Enforcement**:

- `.dependency-cruiser.mjs` rule `forbid-production-to-demo` — production→_demo is ERROR
- `.dependency-cruiser.mjs` rule `no-cross-domain` — exempts `_demo/` (allowed to import production)

## When this code runs

```
APP_MODE != 'production'  →  routes mounted at /api/_mock-ota/*
APP_MODE == 'production'  →  registerDemoRoutes() is no-op; routes return 404
```

Triple defense from production leak:

1. Env-gate (this layer)
2. Reserved-test-ranges shield (Round 8 — `feedback_outbound_side_effect_discipline_2026_05_22`)
3. YDB native TTL P1D on `mockOta_*` tables (when implemented Phase 2)

## Folder layout

```
_demo/
├── README.md                  ← you are here
├── index.ts                   ← register(app) entry, called from app.ts
├── mock-ota-server/
│   ├── yandex/                ← HTTP routes mimicking whitelabel.travel.yandex-net.ru
│   ├── ostrovok/              ← HTTP routes mimicking api.worldota.net B2B
│   └── shared/                ← webhook-emit helper, state primitives
└── admin/                     ← reset/seed/trigger-scenario endpoints (Batch 3)
```

Frontend mirror at `apps/frontend/src/_demo/` (TanStack route `/demo/ota/*`).

## Two valid wrapper patterns

This folder uses **both** patterns intentionally — each appropriate in its context:

| Pattern                  | File                                                                                             | When                                                                              | Trade-off                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| **A — Canonical import** | `yandex/yandex.routes.ts` imports `createYandexTravelMock` from `domains/channel/yandex-travel/` | Need full behavior fidelity from Round 8 production mock                          | DRY, single source of truth; tighter coupling      |
| **B — Inline FSM**       | `ostrovok/state.ts` re-implements 5-stage flow inline                                            | Need subset behavior or compensate Round 8 mock bugs without touching frozen code | Loose coupling, no impl binding; logic duplication |

**Phase 2 refactor**: standardize on Pattern A after moving Mock factories to `lib/channel-manager/mocks/` (cleaner stable boundary).

## Why "modular monolith" not microservice

Current Phase-1 = single deploy with env-gated routes. Trade-offs accepted:

| Coupling level | State               | Trade-off                                           |
| -------------- | ------------------- | --------------------------------------------------- |
| Build-time     | shared              | -1 deploy unit, -1 CI/CD pipeline = ops simplicity  |
| Runtime        | env-gated           | production unaffected by demo bugs                  |
| Type           | one-way             | Production cannot accidentally depend on demo types |
| State          | isolated YDB tables | Zero shared mutable state                           |
| Test           | shared suite        | Tag-split deferred to Phase 2                       |
| Deploy         | shared              | Extractable via `mv` when measurable need arises    |

**Exit ramps** are deliberately preserved by folder structure — see canon document.

## How to extend safely

### Adding a new mock-OTA endpoint

1. Add route to `_demo/mock-ota-server/{channel}/{channel}.routes.ts`
2. Add TDD test in `{channel}.routes.test.ts`
3. If webhook emission needed, use `shared/webhook-emit.ts`
4. `bun test apps/backend/src/domains/_demo/` must stay green

### Adding a third channel (e.g. Avito)

1. Create `_demo/mock-ota-server/avito/` mirroring existing structure
2. Register in `_demo/index.ts` via `app.route('/api/_mock-ota/avito/v1', createAvitoMockOtaRoutes(...))`
3. Coordinate с corresponding `domains/channel/avito/` adapter (Round 10 candidate)

### Adding admin demo controls

1. Add endpoint to `_demo/admin/admin.routes.ts`
2. Idempotent reset / seed / trigger-scenario primitives only
3. Wire into demo-control-panel в frontend `_demo/`

## Tests

```bash
bun test apps/backend/src/domains/_demo/
bun test apps/frontend/src/_demo/        # RTL component tests
bunx playwright test demo-ota             # E2E (Batch 3)
```

## Out-of-scope (Phase-2+)

- ❌ Полный каталог объектов (только 1 demo property)
- ❌ Plus cashback / Островок loyalty / промокоды
- ❌ Реальные платежи (только «оплачено» status)
- ❌ Mobile-responsive (desktop-only)
- ❌ Multi-OTA crossover
- ❌ Production deployment of demo routes

See `feedback_round_9_demo_ota_server_canon_2026_05_25.md` for full frozen scope.
