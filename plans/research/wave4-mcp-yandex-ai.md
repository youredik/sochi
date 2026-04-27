# Research: MCP server + Yandex AI + Алиса для HoReCa SaaS

**Дата:** 2026-04-27
**Источник:** research-агент волны 4
**Confidence:** 8/10 (общая)

---

## 0. Главные находки

1. **MCP spec ревизия 2025-06-18** действующая. Roadmap-2026 опубликован 09.03.2026.
2. **`@modelcontextprotocol/sdk` v1.29.0** (~05.04.2026) + **`@hono/mcp`** (последний bump 27.02.2026).
3. **Hospitable MCP** (03.04.2026) — **31 tools** (read + write+action!).
4. **Apaleo Copilot** (26.03.2026) — agentic layer ВНУТРИ Apaleo PMS.
5. **Apaleo MCP Server** (alpha с 22.09.2025) — отдельно, write+payment-aware.
6. **Aven Hospitality MCP** (03.03.2026) — Q2 2026 Early Access.
7. **Mews $300M raise (Jan 2026)** — agentic AI vision, продукт не выпущен.
8. **Yandex AI Studio supports MCP integrations** — наш MCP-сервер совместим с Yandex.
9. **YandexGPT 5.1 Pro: 0.40-0.80₽/1k tokens** — 30-60× дешевле OpenAI/Claude.
10. **Yandex Cloud first-party MCP servers** (`github.com/yandex-cloud/mcp`).

---

## 1. MCP (Model Context Protocol) — Anthropic 2026

### 1.1 Spec status

- **Текущая ревизия:** `2025-06-18` (последний официальный релиз).
- Roadmap-2026 published 09.03.2026.
- В текущем цикле 2026 **новых транспортов НЕ добавляют**.

### 1.2 Транспорты

- **stdio** — для локальных серверов. Канон для Claude Desktop, Cursor, Codex CLI.
- **Streamable HTTP** — current default для remote-серверов. Stateless или stateful (`Mcp-Session-Id` header).
- **SSE** — deprecated с июня 2025.

### 1.3 SDK

- **`@modelcontextprotocol/sdk` v1.29.0** (~05.04.2026, последняя), peer-dep `zod` (v3.25+).
- **v2 анонсирован Q1 2026** как stable, но v1.x остаётся production-recommended ещё 6 месяцев.

### 1.4 Hono adapter

- **`@hono/mcp`** опубликован, **last bump 27.02.2026**.
- Экспортирует `StreamableHTTPTransport`.

```ts
const transport = new StreamableHTTPTransport()
await mcpServer.connect(transport)
app.all('/mcp', (c) => transport.handleRequest(c))
```

Также есть `simpleMcpAuthRouter` для third-party auth.

### 1.5 Authentication (canonical 2026)

- **OAuth 2.1 + PKCE** — обязательно для confidential и public clients.
- **MCP-server = OAuth Resource Server only** (с июня 2025) — token issuance делегирован.
- **Protected Resource Metadata (RFC 9728)** — `.well-known/oauth-protected-resource`.
- **Dynamic Client Registration (RFC 7591)** — SHOULD support.
- **Resource Indicators** — обязательны.

### 1.6 Tool/Resource/Prompt

- **Tools** — функции, которые AI может вызвать (write/read).
- **Resources** — read-only данные (URIs).
- **Prompts** — параметризуемые шаблоны.
- **Tasks (SEP-1686)** — экспериментальный примитив для long-running operations.

### 1.7 Streaming

Через `Mcp-Session-Id` + chunked HTTP responses; для notifications — event-stream + `Last-Event-ID`.

### 1.8 MCP Registry / Marketplace

Anthropic в roadmap-2026: «`.well-known` standard metadata format» для discovery. Community-реестры — `glama.ai/mcp`, `mcpservers.org`.

### 1.9 Enterprise readiness 2026 priorities

Audit trails, SSO, gateway behaviour standards, portable config — приоритет 2026-Q3+.

---

## 2. Hospitable MCP server (03.04.2026) — VERIFIED

- **Endpoint:** `https://mcp.hospitable.com/mcp` (single public).
- **Транспорт:** Streamable HTTP.
- **Auth:** OAuth 2.1 PKCE через браузер.
- **Pricing:** доступно на Host / Professional / Mogul / Legacy планах. **НЕ на Essentials**.
- **Open source:** нет (closed managed-сервер).

### 2.1 Полный список tools (31)

**Read (21):** get-properties, get-property, get-property-images, get-property-reviews, search-properties, get-transactions, get-transaction, get-payouts, get-payout, get-user, get-community-user, get-reservations, get-reservation, get-reservation-messages, get-property-calendar, list-reservation-enrichment-data, get-reservation-enrichment-data, get-inquiries, get-inquiry, get-property-knowledge-hub, submit-feedback.

**Write/Action (16):** send-reservation-message, send-inquiry-message, tag-property, **cancel-reservation**, update-property-calendar, update-reservation-enrichment-data, respond-to-review, **create-reservation**, update-reservation, create-quote, create-property-ical-import, update-property-ical-import, create-knowledge-hub-item, update-knowledge-hub-item, delete-knowledge-hub-item, delete-knowledge-hub-topic.

### 2.2 Use case

STR (short-term rental) host'ы хотят «Claude Desktop, забронируй гостя, проставь тариф, отправь pre-arrival message» end-to-end.

### 2.3 Импликация

Hospitable пошёл сразу на **write-API в v1**. Наш memory-канон («v1 read-only, write на v2») — сохраняем (compliance + audit), но допускаем что **рынок ожидает write уже в v1**. Differentiator на v1 — read-only + русский + Сочи compliance.

---

## 3. Apaleo Copilot + Apaleo MCP Server

### 3.1 Apaleo MCP Server

- **Анонс:** 22.09.2025; **alpha** в текущий момент.
- Доступ через «MCP Alpha Group» в Apaleo Community.
- **Capabilities (declared):** read + **modify bookings, check availability, access loyalty info, coordinate housekeeping, process payments**.
- **Pricing:** не публиковалось.
- **Auth:** не раскрыто (вероятно — Apaleo OAuth).

### 3.2 Apaleo Copilot (26.03.2026)

- Embedded chat-based agentic слой ВНУТРИ Apaleo PMS UI (**не MCP-сервер для внешних AI**; сам Copilot — потребитель MCP).
- Capabilities: проверить arrivals, продлить stay, спланировать housekeeping, разрулить overbookings, назначить номера.
- **Trainable:** клиенты заливают plain-text SOPs — Copilot учится на них (RAG over docs).
- **A2A roadmap:** third-party agents смогут разговаривать с Copilot через MCP/A2A.
- **LLM-провайдер:** не раскрыт публично (Apaleo «vendor-agnostic»).
- **Data residency:** EU-hosted.

### 3.3 Импликация

«Embedded copilot в нашем PMS UI» — валидный **второй продукт** поверх MCP-сервера. Apaleo показывает: **MCP-сервер + Copilot = два разных, дополняющих UX**.

---

## 4. Other hospitality MCP/AI 2026

- **Aven Hospitality** (бывший Sabre Hospitality, $1.1B приобретение TPG 2025): **MCP Enablement 03.03.2026** поверх SynXis CRS + Booking Engine. **Q2 2026 — MCP Early Access Program**. 35,000+ отелей через 190+ стран.
- **Mews:** $300M raise (январь 2026) на agentic AI — vision, продукт не выпущен.
- **Cloudbeds Engage** (запущен апрель 2025) + **Sadie** (партнёрство январь 2026): voice-native AI на **GigaML LLM** + Sadie. «Sub-100ms responses, 5 languages». 25% growth phone-bookings за 30 дней.
- **Choice Hotels:** AI вышел из pilot в core operations (апрель 2026).
- **Российские PMS** (Bnovo / TravelLine / Контур.Отель / Shelter): **публичных AI-ассистентов / MCP-серверов на апрель 2026 НЕТ**. Это наш differentiator.

---

## 5. Yandex AI Studio capabilities 2026

### 5.1 Модели

- **YandexGPT 5 / 5.1 Pro** — flagship. Chain-of-Reasoning mode (аналог o3). До **32k context window**. **Function calling / tool use поддерживается**.
- **YandexGPT 5 Lite** — real-time, function invocation, embeddings.
- **YandexART** — image gen.
- **Embeddings** — для семантического поиска.
- **Inference 2.5x быстрее** против YandexGPT 4 Pro.

### 5.2 API surface (2026, GA)

- **Responses API** — text agents (OpenAI-compatible).
- **Realtime API** — voice agents (WebSocket transport, OpenAI Realtime API совместимость).
- **Vector Store API** — search через документы.
- **Files API**, **Assistants API** (CRUD assistants, threads, runs, messages).
- **Function Tool / Search Index Tool / Generative Search Tool** — built-in tools.

### 5.3 ⚠️ MCP support

**«AI Studio supports MCP integrations»** (по докам). Yandex AI Studio может **выступать MCP-клиентом**, подключаясь к нашему MCP-серверу. Наш ассистент в admin-UI (на YandexGPT) можно пустить через тот же MCP-сервер, который пишем для Claude/ChatGPT.

### 5.4 Yandex Cloud first-party MCP servers

`github.com/yandex-cloud/mcp` — Yandex выпустил MCP-серверы для **Functions, Serverless Containers, MCP Gateway**. Платформа канон для self-hosted MCP-deployment.

### 5.5 Pricing 2026 (рубли)

- **YandexGPT 5.1 Pro:** **0.80 ₽ / 1k tokens** (sync); **0.40 ₽ / 1k async**.
- **YandexGPT 5 Lite:** ~0.20 ₽/1k.
- **Alice AI LLM:** 0.50 ₽/1k input + 1.20 ₽/1k output.
- **Free tier:** starter grants + promo codes с 03.03.2026.
- В долларах (async Pro): ~$0.005/1k tokens — **в 30-60× дешевле OpenAI GPT-4 / Claude Sonnet**.

### 5.6 RAG / Vector DB

AI Studio имеет **встроенный Vector Store API** + CLI-tool для индексации S3, локальных файлов, MediaWiki, Confluence. **Не нужен внешний Pinecone / Qdrant / Weaviate**.

### 5.7 Self-hosted YandexGPT — НЕТ

Только через AI Studio API. ОК для Yandex-Cloud-only канона.

### 5.8 OpenAI-compat

AI Studio API «**fully compatible with OpenAI API**» (Responses + Realtime + Vector Store). Любой OpenAI SDK работает с base_url=Yandex.

---

## 6. SpeechKit + Алиса для hospitality

### 6.1 SpeechKit ASR

- **Streaming mode** — sub-100ms latency.
- **Sync mode** — для коротких команд.
- **Async mode (long audio)** — billable unit 1 sec audio per channel.
- Автодетект языка, multi-speaker, post-processing через LLM.

### 6.2 SpeechKit TTS

- **API v3** — request-based billing; streaming, unsafe_mode для long phrases.
- **API v1** — character-based.
- **Brand Voice** + **Brand Voice Adaptive** — кастомные голоса.
- Streaming TTS production-grade.

### 6.3 Pricing 2026 (примерные)

- ASR streaming: ~0.16-0.20 ₽ / sec (~9.6-12 ₽ / минуту).
- TTS API v3 standard: ~0.40 ₽ / запрос.
- Brand Voice: ~3-5× standard.

### 6.4 Алиса для отелей

- **Yandex.Station Mini / Max / Mini 2** в номерах — official product line.
- Для гостей: музыка / подкасты / TV, голосовое управление светом.
- **Hotel-staff workflows:** оператор через Alice for Business — информирование, заказ услуг.
- **Privacy:** account auto-disconnect после check-out.
- **Real case:** **Crowne Plaza Moscow** — first hotel-deployment Yandex.Station (2018 vintage).
- Custom hotel-skills через Yandex Cloud Functions (бесплатно).

### 6.5 Voice-to-Booking flow

1. Гость в номере / на телефоне → Алиса/SpeechKit ASR → text + intent.
2. Yandex AI Studio Assistant с function-calling → MCP-tool `booking.create`.
3. SpeechKit TTS / Алиса → подтверждение голосом.
4. Postbox / SMS — формальное подтверждение.

---

## 7. Архитектура MCP-сервера для нашего HoReCa SaaS

### 7.1 v1 (M8.A — конкретный плановый эпик)

**Транспорт:**
- Streamable HTTP через `@hono/mcp` + `@modelcontextprotocol/sdk@1.29.x`.
- Endpoint: `/api/v1/mcp` (single endpoint, multi-tenant через token).
- Stateless по умолчанию.

**Auth:**
- Bridge на Better Auth + organization plugin:
  - Discovery: `GET /.well-known/oauth-protected-resource` → наш Better Auth issuer.
  - Token = Better Auth session JWT с claim `activeOrganizationId`.
  - **Resource Indicator:** `https://api.<our-domain>/api/v1/mcp` обязательно.
- DCR через Better Auth client-registration — Phase 2.

**Tools (v1, READ-only):**
- `bookings.list`, `bookings.get`
- `rooms.list`, `roomTypes.list`, `ratePlans.list`
- `availability.check` — самый ценный voice-booking tool
- `guests.search` (с маскированием ПД)
- `folios.list`, `payments.list`
- `notifications.outbox.list`
- `taxAssessments.list`
- `kpi.summary` — Occupancy / ADR / RevPAR

**Tools (v2 — separate audit-flow):**
- `bookings.create`, `bookings.cancel`, `bookings.update`
- `notifications.send`
- НЕ через MCP: `payments.charge`, `payments.refund` — отдельный fiscalization-flow.

**Resources:**
- `property://current` — JSON с org-spec.
- `room-types://list`.
- `housekeeping-sop://standard` — text/markdown SOPs.

**Prompts:**
- `morning-briefing` — «Покажи arrivals, departures, dirty rooms на сегодня».
- `weekend-occupancy-forecast`.
- `late-checkout-template` — параметризуемое сообщение гостю.

**Multi-tenancy:**
- Per-call: middleware извлекает `activeOrganizationId` из JWT, инжектит в YDB-query.
- Cross-tenant assertion в каждом tool unit-test.
- Single-issuer pinning.

**Tracing:**
- OTEL-span на каждый MCP-call: `mcp.tool.name` / `mcp.tenant.id` / `mcp.duration_ms`.
- Activity-log row через CDC-outbox.

**Hosting:**
- v1: тот же Hono backend.
- v2: отдельный Yandex Cloud Function / Serverless Container. Yandex MCP Gateway — для federation.

**LLM-agnostic:**
- Open standard. Claude / GPT / YandexGPT / Mistral — все могут подключиться.
- Тестируем с Claude Desktop, Yandex AI Studio, собственным admin-UI assistant (YandexGPT).

**Sandbox/Production:**
- Per-tenant `sandbox-mode` flag — read-only fake-data для разработки интеграций.

---

## 8. Multi-LLM strategy

### 8.1 Канон для нашего SaaS

- **YandexGPT 5.1 Pro / Lite** — primary LLM для **внутреннего admin UI assistant'а** (русский, в нашем UI):
  - Дёшево (~$0.005 / 1k async).
  - Russian-native.
  - Yandex Cloud only (compliance).
  - Tool/function-calling работает.
  - Через MCP-client может ходить в наш MCP-сервер.
- **Anthropic Claude / OpenAI GPT** — внешние клиенты MCP (интеграторы, партнёры). Не deploy сами, но наш MCP-сервер обслуживает.
- **OpenAI прямой API** — отказываемся (санкции).
- **Local models** — phase 3.

### 8.2 Решение: dual-LLM

- **Internal:** YandexGPT в admin-UI через AI Studio Assistants API + наш MCP как tools-bridge. **M8.B**.
- **External MCP-сервер:** для всех LLM провайдеров. **M8.A**.

**Нарратив**: «PMS на русском с AI-агентом из коробки + открытый MCP для интеграторов» — уникален в РФ.

---

## 9. Voice-booking сценарий

### 9.1 Flow «гость звонит в отель»

1. Гость → SIP/VoIP-провайдер (Mango Office / UIS / Telphin) → **SpeechKit ASR Streaming**.
2. Real-time transcript → **Yandex AI Studio Realtime API** voice-agent.
3. Voice-agent через **MCP-client** соединён с нашим MCP-сервером (tenant-scoped).
4. LLM делает intent extraction:
   - «Нужен номер на завтра-послезавтра, два гостя» → `availability.check`.
   - «Подтверждаю» → `bookings.create` (v2-tool).
5. **SpeechKit TTS** → подтверждение голосом.
6. Postbox-канал → SMS / Email.

### 9.2 Flow «Алиса в номере»

1. «Алиса, забронируй столик в ресторане на 19:00».
2. Custom Alice Skill → Yandex Cloud Function → MCP-tool `restaurant.reservation.create`.
3. Алиса голосом подтверждает.

### 9.3 Pro/Contra на 2026

**Pro:**
- Cloudbeds Engage показал 25% phone-booking growth за 30 дней.
- 40% звонков в отели остаются без ответа.
- Sub-100ms latency реален в 2026.
- Multilingual auto-detect.

**Contra на v1:**
- Тонкий продукт — нужна качественная intent-extraction.
- Compliance ответственности (запись звонка, согласие на обработку голоса = ПД).
- В Сочи multilingual (русский + английский + китайский + турецкий) — non-trivial calibration.
- **Не критично для closing 7 функций × 3 боли**.

**Recommendation:** voice-booking — **M9 (после демо), не M8**.

---

## 10. Финальная рекомендация — делать ли MCP server в M8?

### **ДА, делать в M8 — с явным разделением:**

#### M8.A — MCP-сервер v1 (read-only) — ~3-5 дней

- `@modelcontextprotocol/sdk@1.29.x` + `@hono/mcp` поверх существующего Hono backend.
- Better Auth bridge (OAuth 2.1 PKCE, Resource Server-only).
- 8-10 read-only tools.
- Resources, Prompts.
- OTEL-tracing + activity-row.
- E2E-test с Claude Desktop + локальный MCP Inspector.
- Pre-done audit gate: cross-tenant × every tool, mask-PII assertions.

#### M8.B — Embedded Admin Assistant на YandexGPT — ~5-7 дней

- Sheet/sidebar в admin-UI (canon из M6.7).
- YandexGPT 5.1 Pro через AI Studio Assistants API.
- Function-calling → MCP-client → наш MCP-сервер.
- 5-10 системных промптов для PMS-задач.
- Streaming responses.
- Conversation state в YDB.

#### M8.C — Public MCP demo + docs — ~1-2 дня

- Публичная страничка с инструкциями подключения Claude Desktop / ChatGPT Apps.
- 1 видео walkthrough.
- Demo-org с anonymized data.

### Отложить в M9+:

- **Write-операции** через MCP (M9.A).
- **Voice-booking** через SpeechKit + Realtime API (M9.B).
- **Алиса skill для номеров** (M10+).
- **A2A** — после Apaleo выпустит spec.
- **DCR** — when partner integrators возникнут.

### Антипаттерны (не делать):

- ❌ Стартовать с write-API в v1 (Hospitable пошёл — у нас нет ни их CDC-outbox-аудита, ни их merchant-of-record).
- ❌ Делать voice-booking до закрытия 7 функций.
- ❌ Закладывать Anthropic-only — MCP open standard.
- ❌ Per-tenant MCP-endpoint — single endpoint multi-tenant через token = 2026 канон.
- ❌ Stateful sessions без острой нужды.

### Почему именно сейчас:

Apaleo и Hospitable релизнули MCP в марте-апреле 2026. Aven Q2-2026. Mews $300M на agentic-AI. Cendyn / HFTP / Revfine консенсус «**2026 = year of MCP**». Если выходим на демо без MCP-сервера к концу M8, **выглядим устаревшими ещё до запуска**. Сделать MCP-сервер v1 read-only поверх существующего Hono RPC = реально 3-5 дней. **Самый дешёвый differentiator в нашем roadmap на 2026**.

---

## Sources

**MCP Protocol & SDK:**
- [The 2026 MCP Roadmap (09.03.2026)](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [MCP Authorization spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [MCP TypeScript SDK GitHub (v1.29.0)](https://github.com/modelcontextprotocol/typescript-sdk)
- [@hono/mcp npm](https://www.npmjs.com/package/@hono/mcp)

**Hospitable:**
- [Connect AI Agent to Hospitable Using MCP](https://help.hospitable.com/en/articles/14424057-connect-an-ai-agent-to-hospitable-using-mcp)
- [Hospitable MCP launch (Apr 3, 2026)](https://community.hospitable.com/hospitable-changelog-3/introducing-the-essentials-plan-and-hospitable-mcp-april-3-2026-1434)

**Apaleo:**
- [Apaleo launches MCP Server](https://apaleo.com/blog/apaleo-news/apaleo-launches-mcp-server)
- [Apaleo Copilot launch (26.03.2026)](https://www.hospitalitynet.org/news/4131640/apaleo-launches-ai-copilot-to-ease-operational-pressure-on-hotel-teams)

**Aven / Mews / Cloudbeds:**
- [Aven Hospitality MCP enablement (03.03.2026)](https://www.prnewswire.com/news-releases/aven-hospitality-announces-mcp-enablement-across-its-platform-strengthening-hotels-position-in-ai-driven-discovery-302701925.html)
- [Mews $300M raise (Jan 2026)](https://hoteltechnologynews.com/2026/01/mews-secures-300-million-to-accelerate-agentic-ai-for-autonomous-hotel-management/)
- [Cloudbeds Engage](https://engage.cloudbeds.com/)
- [Cloudbeds × Sadie voice (Jan 2026)](https://www.heysadie.ai/blog/sadie-launches-cloudbeds-integration-to-automate-guest-calls-and-reservation-management-with-voice-ai)

**Yandex AI Studio / SpeechKit:**
- [Yandex AI Studio overview](https://yandex.cloud/en/services/ai-studio)
- [YandexGPT 5 product page](https://yandex.cloud/en/services/yandexgpt)
- [Yandex SpeechKit](https://yandex.cloud/en/services/speechkit)
- [Realtime API voice agent docs](https://aistudio.yandex.ru/docs/en/ai-studio/operations/agents/create-voice-agent.html)
- [Алиса для отелей](https://yandex.ru/alice/business/hotel)
- [Yandex Cloud MCP servers](https://github.com/yandex-cloud/mcp)
