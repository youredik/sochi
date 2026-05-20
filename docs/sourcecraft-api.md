# SourceCraft REST API — canonical reference

Всё что нужно для полностью автономной работы с CI/CD без UI.
Проверено 2026-05-20 на репо `sepshn/sepshn`.

## Базовые координаты

- **API host**: `https://api.sourcecraft.tech`
- **Swagger JSON**: `https://api.sourcecraft.tech/sourcecraft.swagger.json`
- **Swagger UI**: `https://api.sourcecraft.tech/docs/`
- **Docs portal**: `https://sourcecraft.dev/portal/docs/ru/sourcecraft/operations/api-start.html`
- **Web UI**: `https://sourcecraft.dev/{org}/{repo}/...`
- **Git**: `ssh://ssh.sourcecraft.dev/{org}/{repo}.git`

## Auth

```bash
export SC_PAT='pv1_…'  # personal access token из Security UI
curl -H "Authorization: Bearer $SC_PAT" "https://api.sourcecraft.tech/..."
```

Внутри CI cube доступна `SOURCECRAFT_TOKEN` env var (auto-provided), её и юзаем
для self-reflective scripts (smoke-test читает свой же лог и т.п.).

## CI/CD endpoints (всё через `/repos/{org_slug}/{repo_slug}/cicd/`)

| Endpoint                                                                    | Что делает                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET  /cicd/runs?limit=N`                                                   | Список запусков (новые сверху). Полезно при триаже.                           |
| `GET  /cicd/runs/{run_slug}`                                                | Полный JSON одного запуска: workflows[] → tasks[] → cubes[] с status и dates. |
| `GET  /cicd/runs/{run_slug}/{workflow_slug}`                                | Один workflow внутри запуска.                                                 |
| `POST /cicd/runs`                                                           | Запустить workflow руками (тело: `{workflow, branch, params}`).               |
| `GET  /cicd/logs/{run_slug}/{workflow_slug}/{task_slug}/{cube_slug}?page=N` | **ЛОГИ КУБА** — JSON `{logs, done, ...}`, разбит на страницы.                 |
| `GET  /cicd/artifacts/{run_slug}/{workflow_slug}/{task_slug}/{cube_slug}`   | Артефакты cube (URL-ы для скачивания).                                        |

Также есть `/repos/id:{repo_id}/cicd/runs` варианты, если slug меняется.

### Cube-log pagination

Логи разбиты на страницы по ~600 KB. Endpoint возвращает один и тот же chunk
если страница out-of-range — НЕ полагайся на «empty body = end», смотри на
размер `logs` строки и/или флаг `done` в payload.

## Secrets endpoints

| Endpoint                                   | Что делает                                       |
| ------------------------------------------ | ------------------------------------------------ |
| `GET    /repos/{org}/{repo}/secrets`       | Список (key + base64-value).                     |
| `PUT    /repos/{org}/{repo}/secrets/{key}` | Создать/обновить. Body: `{"value": "<base64>"}`. |
| `DELETE /repos/{org}/{repo}/secrets/{key}` | Удалить.                                         |

PUT принимает значение **в base64** (не plain). Encoding пример:

```bash
echo -n "my-secret-value" | base64
```

## Workflow definitions

- Файл `.sourcecraft/ci.yaml` в корне репо
- Структура: `workflows:` → `tasks:` (list of refs) → top-level `tasks:` definitions → `cubes[]`
- Каждый cube — отдельный Docker container
- Между cubes общий workspace mount (git checkout)
- `needs: [cube_name]` — DAG dependencies внутри task
- Изображения: любой публичный registry + `cr.yandex/sourcecraft/{yc-iam,yc-cli}:latest`

## Service Connection (OIDC tokens.yc.\*)

В YAML доступно через `${{ tokens.yc.* }}`:

- `tokens.yc.id_token` — OIDC ID-токен для exchange на YC IAM
- `tokens.yc.service_account_id` — SA ID к которому привязана connection
- `tokens.yc.folder_id` — default folder из connection (часто **НЕ тот** где deploy-target живёт; см. Pitfall #4)

Создаётся в UI: Settings → Service Connections → новая → выбрать YC org/cloud,
получить OIDC trust policy → создать SA в YC с этим trust → bind к workflow.

## Headers/body for common ops

### GET cube logs

```bash
curl -H "Authorization: Bearer $SC_PAT" \
  "https://api.sourcecraft.tech/repos/{org}/{repo}/cicd/logs/{run}/{workflow}/{task}/{cube}?page=1"
```

Response: `{"logs": "<plain-text>", "done": true/false, ...}`

### PUT secret

```bash
VALUE=$(echo -n "my-value" | base64)
curl -X PUT -H "Authorization: Bearer $SC_PAT" -H "Content-Type: application/json" \
  -d "{\"value\":\"$VALUE\"}" \
  "https://api.sourcecraft.tech/repos/{org}/{repo}/secrets/MY_KEY"
```

### Trigger workflow

```bash
curl -X POST -H "Authorization: Bearer $SC_PAT" -H "Content-Type: application/json" \
  -d '{"workflow":"quality","branch":"main","params":{}}' \
  "https://api.sourcecraft.tech/repos/{org}/{repo}/cicd/runs"
```

## Pitfalls встретили эмпирически

1. **«workflow by name not found» на logs endpoint** — путь должен иметь
   все 4 path-сегмента в порядке `{run}/{workflow}/{task}/{cube}`. Query-param
   варианты НЕ работают (даже если выглядят правдоподобно).
2. **Slug ≠ имя из yaml directly** — `workflow_slug` это имя из `workflows:` ключа
   в ci.yaml, `task_slug` — `name:` из task definition, `cube_slug` — `name:` из
   cube definition. **Внутренние slug'и (`#prepare-image-for-X`, `#git-clone`,
   `#create-environment`) фечатся отдельно и могут падать на parse в API**.
3. **MCR registry имеет ТОЛЬКО stable Playwright tags** — alpha pre-release
   versions нужно либо избегать в `@playwright/test`, либо устанавливать
   browsers вручную (apt + playwright install). Match image к npm version.
4. **`tokens.yc.folder_id` ≠ target deploy folder** — Service Connection обычно
   привязан к infra-folder (где SA живёт). Если контейнер/функция в demo-folder,
   нужен ОТДЕЛЬНЫЙ secret `YC_DEMO_FOLDER_ID` и его инжектить. Иначе ловишь
   «resource with name '**_' not found» (масштабирование через `_**` идёт по
   secret-маске, не по token-полю).
5. **`yc-cli:latest` image не auto-читает `YC_IAM_TOKEN` env** при `entrypoint: ""`.
   Канон: explicit `--token "$YC_TOKEN"` flag в каждой `yc` команде. Или
   `export YC_TOKEN="$YC_IAM_TOKEN"` первой строкой script (stankoff line 338).
6. **`amazon/aws-cli` image** имеет `aws` как entrypoint. SourceCraft передаёт
   `sh -c <script>` → aws видит `sh` как subcommand. Override через
   `image: {name: ..., entrypoint: ''}` (то же для `yc-cli`, `hashicorp/terraform`).
7. **`AWS_DEFAULT_REGION=ru-central1-`** (с trailing dash) — SourceCraft Service
   Connection inject value с лишним символом. Explicit override в `env:` обязателен:
   `AWS_DEFAULT_REGION: ru-central1`.
8. **Bun в `node:24-slim`** — `npm install -g bun@X` кладёт в `/usr/local/bin/bun`
   (system PATH, доступен subprocess'ам run-p). curl-installer кладёт в
   `$HOME/.bun/bin` и требует ручного PATH export (рискованно через многослойные
   subprocess чейны).
9. **Logs API возвращает ОДНУ страницу даже на `?page=2`** если pagination не
   реализована для этого размера лога. Проверяй `done` поле или сравнивай контент.
10. **Pre-commit/pre-push lefthook** — `pnpm-lock.yaml` после редкого
    `pnpm install --lockfile-only` может изменяться по hash-only причинам; пуш
    с ratchet=0 проходит.

## Helper script

См. `scripts/sc-logs.sh` — обёртка для быстрого fetch'а логов.

## Связанная память

- `~/.claude/projects/-Users-ed-dev-sochi/memory/reference_sourcecraft_api.md` —
  актуальный канон с практическими примерами
- `~/.claude/projects/-Users-ed-dev-stankoff-v2/memory/reference_sourcecraft_secrets_api.md` —
  более ранний канон только по Secrets API (надо обновить со ссылкой на этот документ)
