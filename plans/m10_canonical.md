# M10 — Channel Manager Mock (canonical sub-phase plan)

**Дата:** 2026-05-04
**Track:** A7 (per `plans/ROADMAP.md`) — closes Боль 2.2 (channel distribution closure).
**Scope:** TravelLine + Я.Путешествия + Ostrovok ETG behaviour-faithful Mock'и + canonical adapter interface + bidirectional sync визуально на demo + Booking.com B.XML phase-2-ready.
**Canonical guard:** `feedback_behaviour_faithful_mock_canon.md` — same код для Mock + live (live-flip = factory binding swap, ZERO domain changes).
**Research:** R1 broad (5 parallel agents) + R2 adversarial (1 agent) + R3 empirical npm-verify (1 agent + own curl-verify of 8 packages). **All dates ≥2026-01-01 empirically verified via direct registry.npmjs.org curl 2026-05-04**.

---

## §0. Косяки из предыдущих sub-phases applied upfront

Per session retrospective + recurring user pushbacks:

| Категория | Косяк | Mitigation в этом плане |
|---|---|---|
| Process | Claim "готов к next track" без pre-flight ritual | Pre-flight commit с canonical plan FIRST, не verbal claim |
| Process | Skip per-sub-phase R-rounds | R1 + R2 + R3 + own empirical curl-verify ALL deps на registry.npmjs.org |
| Process | Trust agent dates blindly | Empirical curl на каждую critical lib date + last-publish |
| Process | "Все забыл" — claim done без paste-and-fill audit | DOD checklist в commit body перед TodoWrite completed |
| Process | Defer items "к closure" → forget | Track в TodoWrite + paste-and-fill |
| Process | Skip e2e regression after frontend changes | e2e:smoke run mandatory before commit |
| Process | Memory pointer stale | Update memory + ROADMAP в same commit as implementation |
| Tech | Bundle barrel imports → blowup | code-split + size:check после ЛЮБОГО global import |
| Tech | Tenant strings → XSS via raw HTML sink | Lingui-only copy для UI; node:crypto HMAC для signing |
| Tech | Webhook handler >2s | enqueue → 200 sync, process async (Cloudbeds canon) |
| Tech | Stale 12+mo dep на critical path | empirical npm-verify per lib + caret bump для security-relevant |
| Tech | Mock pretends like live but drift detected на production | Pact bi-directional contract testing + MSW handlers single-source |
| Senior | Объявление "готов" без verifying R-rounds done | R1+R2+R3 canon: each sub-phase pre-flight requires fresh research ≥ today |
| Senior | "Современно или в топку" | Reject stale libs (partial-json 24mo / classic Pact-JS native binding broken on Node 24 ARM64) |
| Senior | Hardcoding dates / VAT rates | system_constants effective-date pattern для регуляторных констант (1 Sept 2025 152-ФЗ / 1 Jan 2026 НДС / 27 Jan 2026 госпошлина) |
| RU compliance | 152-ФЗ data crossing border | Cross-border-transfer gate: deny outbound PII unless RKN notification filed |
| RU compliance | Sanctioned OTAs (Booking/Expedia/Airbnb) | HARD-DISABLE at factory level май 2026; document re-enable trigger |
| RU compliance | МВД миграционный учёт via channel | NEVER — always hotel-side regardless of booking source |
| Bug-hunt | Strict tests canon | adversarial: walk-in × OTA collision / partner_order_id rotation / Checksum mismatch / stuck-in-book timeout / cross-border deny / overbooking SERIALIZABLE FOR UPDATE |

---

## §1. North-star alignment

Закрывает **Боль 2.2** (channel distribution closure) per `plans/ROADMAP.md` Track A DoD item 7: «Channel Manager Mock показывает фейковую sync с TravelLine/Я.Путешествия/Ostrovok».

Per `project_demo_strategy.md` canon: demo IS permanent product surface. Mock-слой остаётся в проде навсегда. Live-flip = factory binding swap, ZERO domain changes.

**Что строится:**
- `ChannelManagerAdapter` canonical interface (TS) с methods: `pushAri(delta)` / `pushAriFull(snapshot)` / `searchAvailability` / `readReservations` / `verifyAndCreate` / `cancelReservation` / `calculateCancellationPenalty` / `receiveBookingWebhook`
- 3 Mock implementations: `TravelLineMock` + `YandexTravelMock` (impersonates Bnovo-CM passthrough) + `OstrovokEtgMock`
- Outbox/Inbox tables (CDC-first per `project_event_architecture.md`)
- CloudEvents 1.0.2 envelope для inbound webhooks
- Inventory buffer + walk-in × OTA collision SOP
- Booking.com phase-2-ready content-type-agnostic adapter base (XML+JSON parity)
- Demo visualization: fake sync flow visible на /widget/demo-sirius admin overlay
- Migration 0050+ для channelConnection + channelSyncLog + outbox + inbox tables

**Что defer'ится:**
- Live commercial integration (TL/YT/ETG партнёрские контракты + sandbox creds) — Track C4 deploy phase
- Booking.com Connectivity API live — Phase 2 of go-live (sanctions context + B.XML mass)
- Multi-tenant cron Coordination Service — M11+ (single-instance via RUN_CRON env-flag)
- Hostaway/Lodgify/Guesty Airbnb-bridges — Phase 3 / sanctions lift
- Real PII cross-border transfer — needs RKN notification + DPA process

---

## §2. Decisions D1-D24 (final, post R1+R2+R3+empirical curl)

| # | Decision | Choice | Rationale (R-round source) |
|---|---|---|---|
| **D1** | TL ARI direction | **TL is source-of-truth; PMS READS via `/search/v1`, never pushes** | R1-TL: docs.travelline.ru DevPortal verified 2026-05-04; "данные хранятся у TravelLine" |
| **D2** | TL reservation reception | **Polling, NO webhook** — `(continueToken \| lastModification−2d) → list` overlap pattern с idempotent dedup by `tlReservationId` | R1+R2-TL #F1: lastModification-minus-2d guidance from TL official docs |
| **D3** | TL auth | **OAuth Client-Credentials → JWT 15-min TTL** at `partner.tlintegration.com/auth/token`. 3 rps / 15 rpm / 300 rph **per-IP** (NOT per-tenant) | R1-TL verified 2026-05-04 |
| **D4** | TL booking creation | **Two-step verify→create** with single-use 24-h `CreateBookingToken` + `Checksum` mismatch → 409 | R1-TL canon |
| **D5** | TL ID mapping | **PMS schema gets `tlRoomTypeId` / `tlRatePlanId` nullable cols** + `tlMappingTable`; mapping config-step required | R1-TL: TL-canonical IDs |
| **D6** | YT integration model | **NO direct PMS API — Mock impersonates downstream of certified CM** (canonical: Bnovo passthrough). Live-flip = onboard via partnered CM, not direct | R1-YT + R2 #F4: 18 certified CMs gatekeeper, "self-build = breach of YT partner agreement" |
| **D7** | ETG auth + endpoint | **HTTP Basic Auth (`id` + `uuid`)** at `https://api.worldota.net/api/b2b/v3/...` (sandbox: `api-sandbox.worldota.net`). REST/JSON. **NO Node/TS SDK** — raw HTTP client | R1-ETG + R3 empirical-confirm: ETG SDK nonexistent на npm |
| **D8** | ETG booking SM | **5-stage state machine**: `search → prebook → book → start → check` + 5s polling cadence + mandatory last-second forced poll | R1-ETG + R2 #F6 |
| **D9** | ETG idempotency | **`partner_order_id` UUID v4 rotated on `double_booking_form` collision**; cap retries at 3 attempts | R1-ETG + R2 #F6: Postman docs confirm rotation canon |
| **D10** | ETG webhook semantics | **Opt-in (support email enable), terminal-only `confirmed`/`failed`. Polling = source of truth.** Stuck-in-book timeout: 90s non-3DS, 600s 3DS | R1-ETG + R2 #F7 |
| **D11** | Inbound webhook envelope | **CloudEvents 1.0.2** (universal idempotency tuple `(source, id)`) — pin `cloudevents@10.0.0` | R1-bidirectional + R3 empirical: cloudevents 10.0.0 published 2025-06-10, CNCF canon |
| **D12** | Webhook inbox table | **`UNIQUE(source, eventId)` inside booking-create transaction** — duplicate webhook → cached 200 idempotent return | R1-bidirectional Apaleo+Cloudbeds canon |
| **D13** | Inventory model | **POOLED (Apaleo-style)** — single `inventory(propertyId, unitGroupId, date)` row, all rate plans derive. SERIALIZABLE tx + `SELECT ... FOR UPDATE` on inventory cell | R1-bidirectional: Apaleo 2026 verified canon |
| **D14** | Outbox retry SM | **Exponential backoff с jitter**: 1m → 5m → 30m → 2h → 12h → DLQ. **Adapter auto-disable after 7 days continuous failure** | R1-bidirectional Apaleo precedent |
| **D15** | Contract testing canon | **MSW handlers (single source) + OpenAPI/JSON-Schema + bi-directional contract via PactFlow OSS** — NOT classic consumer-driven Pact (Pact-JS native binding broken on Node 24 ARM64) | R2 #F9 + R3 empirical: `@pact-foundation/pact@16.4.0` published TODAY 2026-05-04 |
| **D16** | Sanctions HARD-DISABLE | **Booking.com / Expedia / Airbnb adapters factory-level HARD-DISABLED** May 2026. Re-enable trigger documented = sanctions lift + RKN re-notify | R1-RU compliance + R2 confirmed |
| **D17** | Granular consent canon | **3 separate checkboxes** per 1 Sept 2025 152-ФЗ amendments: (a) обработка ПДн для брони / (b) передача отелю / (c) маркетинг — bundled ToS = штраф до 700k ₽ КоАП 13.11 | R1-RU compliance verified |
| **D18** | Operator/processor split | `channel.role ∈ {processor_with_dpa, independent_operator, foreign_recipient}`. TL/Bnovo = processor; YT/Ostrovok = independent operator; foreign OTA = cross-border | R1-RU compliance + R1-bidirectional |
| **D19** | Cross-border-transfer gate | **Deny outbound PII to non-RU recipient unless `crossBorderNotification.{country, status: filed}` exists**. Mock simulates the deny | R1-RU compliance |
| **D20** | МВД миграционный учёт | **ALWAYS hotel-side**, never via channel adapter — channel just supplies guest PII. Госпошлина 500 ₽ since 27 Jan 2026 (PP №44) | R1-RU compliance |
| **D21** | Inventory buffer + walk-in × OTA | **`inventoryBuffer` field per ratePlan (default 1 room held back from OTAs)** + `overbookingDetected` activity event + manual relocation SOP | R2 #F2: real hotels use buffer + manual SOP, not "100% sync magic" |
| **D22** | Booking.com phase-2-ready | **Adapter base content-type-agnostic from day 1** (XML schema + JSON variant validated equivalently). `fast-xml-parser@5.7.2` для B.XML. NOT JSON-first transcoder | R2 #F8: B.XML stays canonical через 2026; OTA_HotelDescriptiveContentNotif sunset 2026-12-31 |
| **D23** | TL polling timing | **Every 1-5 min during business hours** + retry с exponential backoff на 429. Mock simulates real cadence; tests cover lag-window race | R1-TL guidance |
| **D24** | HMAC signing | **Native `node:crypto` HMAC-SHA256** (zero dep, FIPS-aligned, no supply-chain surface). Reserve `@noble/hashes` only для BLAKE3/non-NIST curves | R3 empirical: native crypto canonical 2026 |

---

## §3. Library canon (May 4 2026 npm-empirical-verify done — own curl confirmed)

**ALL versions verified via direct `curl https://registry.npmjs.org/{lib}/latest` 2026-05-04 — NOT trusted from agent reports blindly.**

| Library | Pinned version | Source / status |
|---|---|---|
| `cloudevents` | **`10.0.0`** EXACT | Published 2025-06-10, CNCF canon, Node engines `>=20 <=24` |
| `@pact-foundation/pact` | **`16.4.0`** EXACT | Published **TODAY 2026-05-04 08:12 UTC** — freshest release. Bi-directional via PactFlow OSS |
| `fast-xml-parser` | `^5.7.2` (caret OK) | Published 2026-04-24, 71.9M weekly DL, 0 active CVEs |
| `croner` | `10.0.1` EXACT | Already in deps; published 2026-02-01 |
| `zod` | **bump к `^4.4.3`** | Published TODAY 2026-05-04 07:06 UTC (security-relevant validator; was 4.3.6 stale) |
| `hono` | `^4.12.16` | Published 2026-04-30 |
| `@hono/zod-validator` | `^0.7.6` | Published 2025-12-18 |
| `@noble/hashes` | **NOT NEEDED** | Native `node:crypto` HMAC-SHA256 canonical for adapter signing |
| `partial-json` | **REJECTED** | Stale 24mo (last 2024-05-14); use `JSON.parse` chunked instead |
| ETG SDK (TS/Node) | **DOES NOT EXIST** | Confirmed via npm registry — implement raw HTTP client |
| `jsonrepair` | `^3.14.0` standby | If JSON recovery needed; published 2026-04-16 |

---

## §4. Sub-phase split (golden middle)

### A7.1 Foundation: adapter base + canonical interface + outbox/inbox + CloudEvents (~1.5 days, ~22 tests)
1. `apps/backend/src/db/migrations/0050_channel_connection.sql` — `channelConnection (tenantId, propertyId, channelId, mode ENUM(mock|sandbox|live), credentials JSON encrypted, role ENUM(processor_with_dpa|independent_operator|foreign_recipient), dpaSignedAt, rknOperatorId, syncStatus, lastSyncAt, isEnabled BOOL, createdAt, updatedAt, PRIMARY KEY (tenantId, propertyId, channelId))`
2. `apps/backend/src/db/migrations/0051_channel_sync_log.sql` — append-only diagnostic log
3. `apps/backend/src/db/migrations/0052_outbox.sql` — outbox table (eventId UUID, source, type, dataContentType, data JSON, attempts, nextAttemptAt, state ENUM(pending|inflight|sent|dlq))
4. `apps/backend/src/db/migrations/0053_inbox.sql` — inbox table с `UNIQUE(source, eventId)`
5. `apps/backend/src/db/migrations/0054_property_tl_mapping.sql` — adds `tlRoomTypeId` / `tlRatePlanId` nullable cols on roomType + ratePlan
6. `apps/backend/src/db/migrations/0055_cross_border_notification.sql` — RKN notification ledger
7. `apps/backend/src/lib/channel-manager/adapter.ts` — `ChannelManagerAdapter` canonical interface
8. `apps/backend/src/lib/channel-manager/cloud-events.ts` — CloudEvents 1.0.2 envelope helpers
9. `apps/backend/src/lib/channel-manager/cloud-events.test.ts` — **6 CE tests** (envelope shape / idempotency tuple / signature verify / replay window / malformed reject / extension attribute parsing)
10. `apps/backend/src/lib/channel-manager/outbox.ts` + `outbox.test.ts` — **8 OUTBOX tests** (exponential backoff / DLQ trigger / state transitions / 7-day auto-disable / concurrent retry race / idempotency / dispatch order / partial-batch resume)
11. `apps/backend/src/lib/channel-manager/inbox.ts` + `inbox.test.ts` — **6 INBOX tests** (UNIQUE(source, eventId) / cached 200 dedup / out-of-order delivery / malformed envelope reject / clock-skew tolerance / cross-tenant)
12. `apps/backend/src/lib/channel-manager/inventory-pool.ts` + `inventory-pool.test.ts` — **4 POOL tests** (SERIALIZABLE FOR UPDATE / walk-in × OTA collision / inventoryBuffer respected / overbookingDetected event)

### A7.2 TravelLine Mock: OAuth + polling + verify→create (~1.5 days, ~24 tests)
13. `apps/backend/src/domains/channel/travelline/travelline-mock.ts` — full Mock impl conforming to canonical adapter
14. `apps/backend/src/domains/channel/travelline/travelline-types.ts` — TS types для TL request/response shapes
15. `apps/backend/src/domains/channel/travelline/travelline-mock.test.ts` — **18 TL tests** (OAuth Client-Credentials / 15-min JWT TTL / 3 rps rate-limit headers / 429 + retry-after / continueToken cursor / lastModification−2d overlap / verify→create two-step / Checksum mismatch 409 / 24-h CreateBookingToken expiry / single-use token / cancellation policy reference-point enum / search.v1 pagination / read-reservation-by-id / cross-tenant / dedup by tlReservationId / per-IP NOT per-tenant rate bucket / business-hours polling cadence / mock data fixture stability)
16. `tests/contract/travelline.contract.test.ts` — **6 TL-CONTRACT tests** (Pact bi-directional via PactFlow OSS + MSW handlers)
17. `apps/backend/src/domains/channel/travelline/travelline.factory.ts` + registry registration in `app.ts`

### A7.3 Yandex.Travel Mock: CM-emulation (Bnovo passthrough) (~1 day, ~16 tests)
18. `apps/backend/src/domains/channel/yandex-travel/yandex-travel-mock.ts` — Mock impersonating Bnovo CM passthrough
19. `apps/backend/src/domains/channel/yandex-travel/yandex-travel-mock.test.ts` — **12 YT tests** (push-ARI idempotent / signed JSON POST / HMAC-SHA256 signature / replay window 300s / IP-allowlist gate (real prod) / cancellation policy mandatory / 152-ФЗ residency reject non-RU storage / granular consent 3-checkbox / RUB-only currency / Europe/Moscow no-DST / photos URL-relay model / Алиса AI discoverability metadata)
20. `tests/contract/yandex-travel.contract.test.ts` — **4 YT-CONTRACT tests**

### A7.4 Ostrovok ETG Mock: 5-stage SM + 4-brand fan-out (~1.5 days, ~22 tests)
21. `apps/backend/src/domains/channel/ostrovok-etg/ostrovok-etg-mock.ts` — full Mock impl
22. `apps/backend/src/domains/channel/ostrovok-etg/ostrovok-etg-mock.test.ts` — **16 ETG tests** (HTTP Basic Auth / single creds 4 brands / search → prebook → book → start → check / 5s polling cadence / last-second forced poll / partner_order_id rotation on double_booking_form / 3 commercial models b2b_net|affiliate_gross|b2b_fake_gross / sandbox demo-hotel guard hid=8473727 / webhook terminal-only confirmed/failed / stuck-in-book 90s timeout / source field demux 4 brands / `rg_ext` photo refs (NOT deprecated images) / cancellation `free_cancellation_before` semantics / RU residency / cross-tenant / partner_order_id global uniqueness)
23. `tests/contract/ostrovok-etg.contract.test.ts` — **6 ETG-CONTRACT tests**

### A7.5 Bidirectional sync orchestration + RU compliance gates + demo visualization (~1 day, ~16 tests)
24. `apps/backend/src/domains/channel/sync-orchestrator.ts` — coordinates ARI broadcast across enabled channels
25. `apps/backend/src/domains/channel/sync-orchestrator.test.ts` — **8 SYNC tests** (cross-border-transfer gate deny / sanctions HARD-DISABLE Booking.com factory level / pooled inventory across N channels / inventoryBuffer respected / overbookingDetected event emission / 7-day auto-disable on sustained failure / per-tenant config gate / DPA-required check before activation)
26. `apps/backend/src/domains/channel/migration-uchet.ts` — МВД delegation rejection canon (NEVER via channel)
27. `apps/backend/src/domains/channel/migration-uchet.test.ts` — **3 МВД tests** (channel webhook → still hotel-side / госпошлина 500 ₽ since 27 Jan 2026 / RU citizen vs foreigner branching)
28. `apps/frontend/src/features/admin/channels/channel-status-overlay.tsx` — fake sync visualization on /widget admin (per Track A DoD #7)
29. `apps/frontend/src/features/admin/channels/channel-status-overlay.test.tsx` — **5 CHAN-UI tests** (3 channels visible / status badges / last-sync timestamp / connection error display / mode badge mock|sandbox|live)

### A7 closure (~½ day)
30. `pnpm test:serial` — backend regression clean
31. `pnpm test` — frontend incl. new tests
32. `pnpm size:check` — SPA-index budget defense
33. `pnpm build` + `pnpm exec playwright test --project=smoke` — full e2e regression
34. Memory pointer + done memory (`project_m10_done.md`)
35. ROADMAP A7 row `[✅]`
36. plan §17 implementation log appended per sub-phase

---

## §5. Strict test plan (target ~80 tests + e2e + axe)

- **Foundation (A7.1)**: 6 CE + 8 OUTBOX + 6 INBOX + 4 POOL = **24**
- **TravelLine Mock (A7.2)**: 18 TL + 6 TL-CONTRACT = **24**
- **Yandex.Travel Mock (A7.3)**: 12 YT + 4 YT-CONTRACT = **16**
- **Ostrovok ETG Mock (A7.4)**: 16 ETG + 6 ETG-CONTRACT = **22**
- **Bidirectional + RU compliance + demo (A7.5)**: 8 SYNC + 3 МВД + 5 CHAN-UI = **16**

**Total target: ~102 strict tests + Pact contract tests + axe re-verify on admin overlay.**

---

## §6. Pre-done audit checklist (paste-and-fill в КАЖДОМ commit body)

```
A7.{N} — pre-done audit
- [ ] Per-sub-phase R1+R2+R3 ≥2026-05-04 done (если scope шире baseline pre-flight)
- [ ] D1-D5 TL canonical (polling + lastMod−2d + OAuth 15min + verify→create + ID mapping)
- [ ] D6 YT CM-emulation (NOT direct API)
- [ ] D7-D10 ETG canonical (Basic Auth / 5-stage SM / 5s polling / partner_order_id rotation / webhook terminal-only)
- [ ] D11-D14 bidirectional canon (CloudEvents 1.0.2 / inbox UNIQUE / pooled inventory / outbox 7-day auto-disable)
- [ ] D15 contract testing via MSW + PactFlow OSS bi-directional (NOT classic Pact-JS)
- [ ] D16-D20 RU compliance (sanctions HARD-DISABLE + granular consent 3-checkbox + operator/processor split + cross-border deny + МВД hotel-side)
- [ ] D21-D24 (inventory buffer + Booking.com B.XML parity + TL polling cadence + node:crypto HMAC)
- [ ] axe matrix 48 cells re-run green (A5.3 carry-forward, must NOT regress)
- [ ] size:check 7/7 PASS (no SPA-index regression vs A6 baseline 177.97 KB)
- [ ] e2e:smoke pass (channel-status-overlay axe-clean)
- [ ] 9-gate green: sherif / biome / depcruise / knip / typecheck / build / test:serial / frontend test / e2e:smoke
- [ ] Cross-tenant × every channel adapter method
- [ ] No half-measures: no skip-tests, no biome-ignore без reason, no blanket disable
- [ ] Memory pointer + ROADMAP updated в same commit
- [ ] Empirical npm-verify any new dep date ≥ today via direct registry curl
```

---

## §7. Definition of Done

- [ ] 3 channel Mocks (TL + YT + ETG) production-grade conforming to canonical adapter interface
- [ ] Outbox/Inbox tables operational с CloudEvents 1.0.2 envelope
- [ ] Pooled inventory model + walk-in × OTA SERIALIZABLE collision tests green
- [ ] Pact bi-directional contract tests pass (MSW + PactFlow OSS)
- [ ] Sanctions HARD-DISABLE verified factory-level (Booking/Expedia/Airbnb adapters не register)
- [ ] Cross-border-transfer gate deny verified
- [ ] МВД миграционный учёт ALWAYS hotel-side (channel adapter has no способ delegate)
- [ ] Demo visualization shows fake sync с TL/YT/ETG visible на admin overlay
- [ ] Booking.com B.XML phase-2-ready (content-type-agnostic adapter base)
- [ ] axe matrix 48 cells still green (no regression)
- [ ] 9-gate green
- [ ] All commits pushed origin/main
- [ ] done memory created (`project_m10_done.md`)
- [ ] ROADMAP A7 row ✅ + «Сейчас работаем над» bumped к Track B (deploy phase)

---

## §8. Carry-forward к next phases

- **Live commercial integrations** (TL/YT/ETG партнёрские контракты + sandbox creds) — Track C4 deploy phase
- **Booking.com Connectivity API live** — Phase 2 (sanctions context + B.XML mass + (product, date) lock)
- **Expedia EQC** — Phase 3 (concurrent updates lock + 2026/27 Connectivity Partner Program)
- **Airbnb via Hostaway/Lodgify/Guesty** — Phase 3
- **YDB Coordination Service** для multi-instance cron — M11+
- **`publicPhone` column** на organizationProfile — M11 admin UI (carry-forward от A5/A6)
- **Real RKN notification flow** + DPA digital signing — M11 admin UI
- **Migration уведомление через Скала-ЕПГУ** — M8.B КриптоПро integration (separate track)
- **Channel-bookings dashboard** — DataLens external (per `project_dashboard_external.md`)

---

## §17. Implementation log

### A7 pre-flight — 2026-05-04

**Research rounds (≥4 per ROADMAP §217 mandate):**
- **R1 broad (5 parallel agents)**: TravelLine canonical 2026 / Yandex.Travel 2026 / Ostrovok ETG API v3 / bidirectional ARI sync architecture / RU compliance + 152-ФЗ
- **R2 adversarial (1 agent)**: 13 challenges → 10 critical findings refining or rejecting R1
- **R3 empirical npm-verify (1 agent + own curl-verify)**: 8 packages directly fetched from registry.npmjs.org с last-publish dates verified
- **Own curl-verify (sеньер canon: верифицируй before trust)**: cloudevents@10.0.0 (2025-06-10), pact@16.4.0 (TODAY), zod@4.4.3 (TODAY), croner@10.0.1 (2026-02-01), fast-xml-parser@5.7.2 (2026-04-24), @noble/hashes@2.2.0 (2026-04-11), hono@4.12.16 (2026-04-30), @hono/zod-validator@0.7.6 (2025-12-18) — все REAL.

**24 decisions baked from R-rounds:**
- D1-D5 TravelLine canonical (polling-not-webhook, source-of-truth ARI, OAuth 15min JWT, verify→create with Checksum, TL-canonical ID mapping)
- D6 Yandex.Travel CM-emulation (NO direct PMS API; Mock impersonates Bnovo passthrough)
- D7-D10 Ostrovok ETG canonical (Basic Auth, 5-stage SM, partner_order_id rotation, webhook terminal-only)
- D11-D14 bidirectional canon (CloudEvents 1.0.2, inbox UNIQUE, pooled inventory, outbox 7-day auto-disable)
- D15 contract testing pivot: MSW + PactFlow OSS bi-directional (classic Pact-JS rejected — Node 24 ARM64 native binding broken)
- D16-D20 RU compliance (Booking/Expedia/Airbnb sanctions HARD-DISABLE, granular consent 1 Sept 2025, operator/processor split, cross-border-transfer gate, МВД always hotel-side)
- D21-D24 (inventory buffer + walk-in × OTA SOP, Booking.com B.XML phase-2-ready, TL polling cadence, node:crypto HMAC)

### A7.1 (commit pending)
TBD — Foundation findings.

### A7.2 (commit pending)
TBD — TravelLine Mock findings.

### A7.3 (commit pending)
TBD — Yandex.Travel Mock findings.

### A7.4 (commit pending)
TBD — Ostrovok ETG Mock findings.

### A7.5 (commit pending)
TBD — bidirectional + RU compliance + demo findings.
