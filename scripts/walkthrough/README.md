# Walkthrough recorder

Auto-generates a narrated MP4 product tour from the live frontend + backend.
Covers the full feature surface — onboarding → wizard → daily ops → finance →
admin reporting. Used for marketing demos, release notes, onboarding clips.

**Not a test.** No assertions, doesn't gate pre-push. Per-chapter failures are
logged + screenshot-dumped to `.artifacts/walkthrough/fail-{id}.png`; recording
continues so a partial tour is always recoverable.

## What's recorded — 16 chapters, ~3:20, ~5.6 MB

| #  | Chapter                       | What user sees                                          |
| -- | ----------------------------- | ------------------------------------------------------- |
| 01 | HoReCa Sochi                  | Landing → login screen                                  |
| 02 | Регистрация владельца         | Signup form fill, 152-ФЗ consent, submit                |
| 03 | Wizard 1: Гостиница           | Property step, Сочи default, налог 200 б.п.             |
| 04 | Wizard 2: Тип номера          | Standard double room                                    |
| 05 | Wizard 3: Номера              | Add 101 + 102, optional floor                           |
| 06 | Wizard 4: Тариф               | BAR 5000₽/night, finish wizard                          |
| 07 | Шахматка                      | API-seed 5 bookings → populated grid                    |
| 08 | Создание бронирования         | Cell click → guest fill → submit (one more on day 5)    |
| 09 | Заезд гостя                   | Band click → "Заезд" → palette flip blue→black          |
| 10 | Фолио гостя                   | Add 5000₽ accommodation line via API → folio page       |
| 11 | Принять оплату                | Mark Paid Sheet → "Принять" → toast 5000₽               |
| 12 | Выезд гостя                   | Goto grid → band click → "Выезд"                        |
| 13 | Дебиторская задолженность     | KPI cards, aging breakdown, debtors table               |
| 14 | Туристический налог           | Q1 KPI, monthly breakdown, per-booking rows             |
| 15 | Журнал уведомлений            | Email log, status filters                               |
| 16 | HoReCa Sochi (recap)          | Dashboard final shot                                    |

## How it works

1. **TTS** — `tts.ts:pickTts()` selects provider:
   - Default: macOS `say` with `Milena` (ru_RU, zero-config, offline).
   - When `YC_API_KEY + YC_FOLDER_ID` are set in `.env`: Yandex SpeechKit
     with `Алиса` (stub in `tts.ts` — implement when keys arrive).
   Each chapter narration → MP3 + measured duration via `ffprobe`.

2. **ffmpeg concat** — chapter MP3s glued with 0.4s `anullsrc` silence
   between them → single audio track.

3. **Playwright 1.59 screencast** — headless Chromium against `localhost:5273`:
   - `page.screencast.start({ size: 1280×720, quality: 85 })`
   - Per chapter: `showChapter(title, description, 2500ms)` overlay, then
     `showActions({ position: 'top-right', fontSize: 22 })` highlights
     interacted elements + action labels.
   - Action time padded with `waitForTimeout` to match the chapter's
     narration MP3 duration (rough sync — see Findings #8).

4. **ffmpeg mux** — WEBM + combined MP3 → MP4 (H.264 medium/CRF23 + AAC
   128k mono 22050Hz, `+faststart` for streaming).

## Prerequisites

- **macOS** (for `say` Milena voice; SpeechKit lifts this when wired).
- **`ffmpeg`** on PATH — `brew install ffmpeg`.
- **Dev servers running** — `pnpm dev` (frontend `:5273`, backend `:3000`).
- **No other E2E session running** — they share YDB and port-thrash the
  dev servers. Wait for `pnpm e2e` / `pnpm test` to finish first.
- **Clean local YDB not strictly required** — script signs up a fresh
  `tour-{ts}@sochi.local` user with timestamped slug, so re-runs don't
  collide. But heavily polluted DB may slow CDC consumer (Findings #3).

## Usage

```sh
pnpm walkthrough
```

Output: `.artifacts/walkthrough/tour.mp4` (gitignored).

Open: `open .artifacts/walkthrough/tour.mp4` (macOS QuickTime).

## Inspecting individual frames

`tour.mp4` is muxed but the underlying `tour.webm` (raw screencast) and
per-chapter audio MP3s are kept in `.artifacts/walkthrough/audio/` for
debugging. Extract a still from any timestamp:

```sh
ffmpeg -y -i .artifacts/walkthrough/tour.mp4 -ss 95 -frames:v 1 \
  /tmp/preview-95s.png
```

Useful timestamps for the current 16-chapter tour:

| Time   | Chapter             | What you see                          |
| ------ | ------------------- | ------------------------------------- |
| ~25s   | 02 Регистрация      | Signup form filled                    |
| ~80s   | 07 Дашборд (transition) | 4 cards: Шахматка / Дебиторка / Налог / Уведомления |
| ~95s   | 07/08 Шахматка      | Populated grid + booking dialog       |
| ~110s  | 09 Заезд            | Black "В прожи…" band, toast          |
| ~135s  | 11 Платёж           | Folio page, 5000₽ payment, balance 0  |
| ~155s  | 13 Дебиторка        | KPI + aging                           |
| ~175s  | 14 Налог            | Tax KPI + monthly breakdown           |

## Adding a chapter

1. Append to the `chapters: Chapter[]` array in `chapters.ts`.
2. Each `Chapter`:
   - `id` — `kebab-case` with `NN-` prefix
   - `title`, `description` — `showChapter` overlay text (description shows
     under the title with smaller font)
   - `narration` — Russian, target ~12-15s when read by Milena (~140
     characters at default rate). Going under 10s feels rushed; over 16s
     drags. See Finding #13.
   - `run(page, state)` — Playwright actions. Mutate `state` to share
     IDs with later chapters (orgSlug, bookingId, folioId, propertyId).
3. **Reuse selectors from `tests/e2e/*.spec.ts`** — they're the ground-
   truth for what works. Don't invent new locators.

## Known gotchas — read before editing

These tripped me during the initial buildout. Skipping them re-introduces
the bug.

### `data-booking-id="pending_*"` placeholder leak

The grid renders an optimistic band immediately after dialog submit, with
`data-booking-id="pending_<uuid>"`. Server-truth replaces it ~200-500ms
later. **Capturing too early gives invalid ID** — the folio API regex
`/^book_[26]$/` rejects it with 400 ZodError.

Always filter by prefix:
```ts
const band = page.locator(`[data-booking-id^="book_"][aria-label*="${date} —"]`).first()
await band.waitFor({ timeout: 10_000 })
```
NOT `[data-booking-id]` alone. (Findings #1.)

### Wizard inputs don't auto-clear after submit

After clicking "Добавить номер" with field "101", the input still contains
"101". `pressSequentially("102")` appends → "101102" → invalid. Always:
```ts
await field.fill('')
await field.pressSequentially('102', { delay: 80 })
```
(Findings #4.)

### CDC backlog under burst load

Chapter 7 seeds 5 bookings via API in <500ms. Each fires `bookingCreated`,
the folio-creator CDC consumer is sequential. By the time chapter 10 polls
for the user-flow booking's folio, the consumer is 12-15s behind. Mitigation:
20s polling deadline + fallback POST `/folios` with `Idempotency-Key`. See
chapter 10 source. (Findings #3.)

### Folio page header has no "Шахматка" link

Header on `/o/{slug}/bookings/{id}/folios/{id}` only shows "Дашборд".
Don't `getByRole('link', { name: /Шахматка/ })` from a folio context —
will time out at 30s. Use `page.goto()` directly. (Findings #2.)

## Swapping TTS to Yandex SpeechKit (Алиса)

When `YC_API_KEY + YC_FOLDER_ID` arrive in `.env`:

1. Implement `speechKitAlisa.synthesize()` in `tts.ts` — REST POST to
   `https://tts.api.cloud.yandex.net/speech/v3/utteranceSynthesis` with
   header `Authorization: Api-Key {YC_API_KEY}`, body
   `{ text, outputAudioSpec: { containerAudio: { containerAudioType: "MP3" } }, hints: [{ voice: "alyss" }] }`.
2. Stream binary MP3 → write to disk → ffprobe duration → return `TtsResult`.
3. `pickTts()` already routes to it when env vars are present. No other
   code changes needed.

Voice options to consider beyond `alyss` (Алиса):
- `alena` — neural female, "корпоративный" tone (default in Stripe-style demos)
- `jane` — neural female, softer
- `filipp` — neural male

## FINDINGS.md — bugs found while recording

[`FINDINGS.md`](FINDINGS.md) accumulates real product bugs surfaced during
recording (P0-P3 ranked). Each new walkthrough run that surfaces a new
issue → add an entry. Don't fix in walkthrough session — work around (like
`book_*` prefix), record in FINDINGS, fix in a separate branch.

Currently 13 findings logged, including:
- **P0?** Tax page possibly displays amounts ~10 000× off (kopeck/ruble
  double-convert).
- **P1** Optimistic-band ID leak (covered above).
- **P1** CDC consumer lag under burst.

## Why `scripts/walkthrough/` and not `tests/walkthrough/`?

Tests have assertions and fail on regressions. This is a one-shot artifact
producer for stakeholder consumption. Lives in `scripts/` alongside
`smoke.ts` for the same reason — both are dev tools, not pre-push gates.
