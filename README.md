# HoReCa SaaS — локальный dev-стек

Локальное окружение для разработки PMS-системы для малого бизнеса гостеприимства в регионе Большого Сочи.

## Что поднимается

| Сервис | Назначение | Dev | Prod |
|---|---|---|---|
| YDB | Основная БД | `ydbplatform/local-ydb:25.3.1.25` (single-node, in-memory) | Yandex Managed Service for YDB (Serverless) |
| MinIO | S3-совместимое хранилище | `minio/minio` | Yandex Object Storage |
| Mailpit | SMTP-перехватчик для писем | `axllent/mailpit` | Yandex Postbox (SESv2) |

## Требования

- Docker 29+ с Docker Compose v5+
- curl, nc (для healthcheck скриптов)
- Свободные порты: 1125, 2235, 2236, 8125, 8865, 9100, 9101
  (сдвинуты на +100 от дефолтов, чтобы не конфликтовать с другими локальными Docker-стеками, например stankoff-v2)

## Быстрый старт

```bash
# 1. Поднять инфру
docker compose up -d

# 2. Применить схему YDB (17 таблиц)
./scripts/apply-schema.sh

# 3. Проверить что всё поднялось
./scripts/verify-infra.sh
```

## UI-консоли

- **YDB monitoring**: http://localhost:8865/
- **MinIO console**: http://localhost:9101/ (логин: `minioadmin` / `minioadmin`)
- **Mailpit**: http://localhost:8125/

## Подключение из кода (будет в backend/)

```env
YDB_CONNECTION_STRING=grpc://localhost:2236/local
S3_ENDPOINT=http://localhost:9100
S3_BUCKET=horeca-files
SMTP_HOST=localhost
SMTP_PORT=1125
```

Полный список переменных — в `.env.example`.

## Структура каталога

```
sochi/
├── docker-compose.yml         # YDB + MinIO + Mailpit + bucket bootstrap
├── schema/
│   └── 0001_init.yql          # 17 таблиц: Better Auth + PMS + инфра
├── scripts/
│   ├── apply-schema.sh        # Применить миграции к локальной YDB
│   └── verify-infra.sh        # Healthcheck всех сервисов
├── .env.example               # Шаблон переменных
├── .gitignore
└── README.md
```

## Управление

```bash
# Остановить (данные сохранятся в volume'ах)
docker compose stop

# Удалить всё, включая данные
docker compose down -v

# Логи
docker compose logs -f ydb
docker compose logs -f minio
docker compose logs -f mailpit

# Применить заново схему после `down -v`
docker compose up -d && ./scripts/apply-schema.sh
```

## Automated gates

Проверки запускаются автоматически git-хуками (`lefthook.yml`) —
отдельно разбивать не нужно, коммит / push сам их вызовет.

**pre-commit** (быстрые, без DB):
- `pnpm biome check` — форматирование + линтинг
- `pnpm sherif` — monorepo version consistency
- `pnpm typecheck` — TS strict (3 проекта)
- `pnpm knip` — dead exports / unused files
- `pnpm depcruise` — архитектурные правила (no-cross-domain, routes→service→repo DAG)

**pre-push** (полные, требуют локального YDB):
- `pnpm test` — vitest full suite (unit + integration vs real YDB)
- `pnpm build` — production bundle (shared tsc + frontend vite)
- `pnpm smoke` — **comprehensive E2E smoke** через `scripts/smoke.ts`

### `pnpm smoke` — что именно проверяет

In-process прогон через реальный Hono app + реальный YDB. Стартует CDC
consumer, создаёт 2 tenants, полную доменную цепочку (property → roomType
→ ratePlan → rate → availability), прогоняет 7 бронирующих сценариев
(idempotency cached replay, 422 на diff body, external-ID dedup, 5-state
machine checkIn→checkOut, cancel returns inventory, markNoShow
irreversible, overbooking race `Promise.all`), cross-tenant adversarials,
CDC activity population, tourism-tax quarterly report aggregate.

Exit 0 только если все 20+ assertions прошли. Скрипт воспроизводимый —
повторный запуск на том же коде снова green (idempotent cleanup).

Требует запущенного `docker compose up ydb` + applied migrations
(`pnpm migrate`).

### `pnpm smoke:fresh` — regression from absolute zero

`pnpm smoke:fresh` = `infra:reset` (docker compose down -v + up + migrate)
+ `smoke`. Проверяет, что весь стек поднимается с пустого места:

- wipe YDB volume
- fresh YDB container
- все 5 миграций применяются (включая CDC changefeed + consumer
  `activity_writer` в migration 0005)
- CDC consumer регистрируется и читает топик
- 21 assertions smoke проходят end-to-end

Запускайте **перед каждым крупным PR** если трогали migrations, schema,
или CDC wiring. Полная проверка ≈ 30 секунд на локальной машине.

## Что дальше

Следующие шаги (см. memory):
1. ~~Локальная инфра~~ — готово.
2. Terraform-скелет для prod-инфры в Yandex Cloud (12 ресурсов).
3. Каркас приложения: `apps/backend` (Hono + `@ydbjs/*` + better-auth) и `apps/frontend` (Vite + React 19 + TanStack).
