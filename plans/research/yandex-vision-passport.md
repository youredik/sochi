# Research: Yandex Vision OCR (модель `passport`)

**Дата:** 2026-04-27
**Источник:** research-агент волны 1
**Confidence:** High (endpoints, формат, поля entities), Medium (точные latency, quotas, биллинг по моделям)

---

## 0. Критическая находка — Vision переехал в Yandex AI Studio

**В 2026 Yandex Vision OCR переехал из Yandex Cloud в Yandex AI Studio.**

- Документация на `yandex.cloud/ru/docs/vision/*` теперь редиректит на **`aistudio.yandex.ru/docs/ru/vision/*`**.
- Директория `vision/` полностью удалена из публичного `yandex-cloud/docs` (master).
- **API endpoint остался прежним:** `ocr.api.cloud.yandex.net` — переехала только документация и биллинг-маркетинг.
- IAM/SA-key сохранены, но в API-ключах добавлены scopes: `yc.ai.vision.execute` (только Vision) и `yc.ai.foundationModels.execute` (Vision + GPT/Image/SpeechKit/Translate).
- С 1 мая 2026 Yandex Cloud повышает цены 5–10% на Compute и Data Platform, **но AI Studio (включая Vision OCR) явно исключён** — цены не меняются.

**Действие:** обновить URL в memory с `yandex.cloud/ru/docs/vision` на `aistudio.yandex.ru/docs/ru/vision`. Канон Yandex Cloud only сохраняется (AI Studio — часть Yandex Cloud).

---

## 1. API спецификация

### 1.1 Endpoints

| Режим | Метод | URL |
|---|---|---|
| Synchronous | POST | `https://ocr.api.cloud.yandex.net/ocr/v1/recognizeText` |
| Asynchronous | POST | `https://ocr.api.cloud.yandex.net/ocr/v1/recognizeTextAsync` |

API единая — `v1`. gRPC доступен параллельно REST. Async возвращает `operation_id`, далее polling.

### 1.2 Формат запроса

**JSON с base64-encoded payload** — НЕ multipart, НЕ raw bytes:

```jsonc
{
  "mimeType": "image/jpeg",          // image/jpeg | image/png | application/pdf
  "languageCodes": ["ru", "en"],     // ["*"] = автоопределение
  "model": "passport",                // см. список ниже
  "content": "<base64-encoded image>" // без data: префикса
}
```

### 1.3 Ограничения по входу

| Параметр | Sync | Async |
|---|---|---|
| Max file size | **10 MB** (≈7.5 MB raw после base64) | 10 MB |
| Max image dimensions | **20 MP** | 20 MP |
| PDF страниц | **1** | до **200** |
| MIME types | `image/jpeg`, `image/png`, `application/pdf` | те же |
| Языки | 48 поддерживаемых | те же |

**HEIC напрямую НЕ поддерживается** — критично для iOS-кейса гостя. Нужен конвертор HEIC→JPEG (на клиенте `heic2any` или на бэке `sharp` libheif).

### 1.4 Авторизация (2026)

Три варианта:

1. **IAM token** (рекомендация для прода): SA → JWT → exchange → IAM token (TTL ≤12h, обновлять каждый час). `Authorization: Bearer <iam-token>`.
2. **API key** (`Api-Key <key>`) — не истекает, проще, но менее безопасен. С 2026 имеют scope.
3. **Static SA key (sa-key.json)** — для long-running workers и CI.

**Канон 2026 для прода:** SA + sa-key.json в Lockbox + cached IAM token с auto-rotate. API-key только для smoke-тестов и Postman.

### 1.5 Поддерживаемые модели

| Модель | Что распознаёт |
|---|---|
| `text` | Свободный текст |
| `page` | Текст на структурированной странице |
| `table` | Таблицы (только ru+en) |
| `handwritten` | Рукопись (ru+en) |
| `line` | Одна строка |
| **`passport`** | Паспорта 20 стран |
| `driver-license-front/back` | Водительские удостоверения |
| `vehicle-registration-front/back` | СТС / ПТС |
| `license-plates` | Госномера |

**СНИЛС, ИНН, визы, миграционные карты — отдельных моделей НЕТ.** Через `text`/`page` + парсинг fullText regex.

### 1.6 Поддерживаемые страны для `passport`

**20 стран:** Россия (внутренний), Россия (РВП/ВНЖ), Азербайджан, Армения, Беларусь, Грузия, Германия, Израиль, Италия, Казахстан, Кыргызстан, Латвия, Молдова, Таджикистан, Тунис, Туркменистан, Турция, Узбекистан, Украина, Франция.

**Загранпаспорт РФ** распознаётся через MRZ-зону. Поля те же + `expiration_date`.

---

## 2. Структура ответа

### 2.1 Базовый ответ

```jsonc
{
  "result": {
    "textAnnotation": {
      "width": "1240",
      "height": "1754",
      "blocks": [
        {
          "boundingBox": { "vertices": [{ "x": "...", "y": "..." }, ...] },
          "lines": [
            {
              "boundingBox": {...},
              "words": [
                {
                  "boundingBox": {...},
                  "text": "Иванов",
                  "confidence": 0.0,        // ⚠️ часто 0 — см. ниже
                  "languages": [{ "languageCode": "ru", "confidence": 1.0 }],
                  "entityIndex": "0"
                }
              ],
              "confidence": 0.0
            }
          ]
        }
      ],
      "entities": [
        { "name": "surname", "text": "Иванов" },
        { "name": "name",    "text": "Иван"   },
        { "name": "middle_name", "text": "Иванович" },
        { "name": "gender", "text": "male" },
        { "name": "citizenship", "text": "rus" },
        { "name": "birth_date", "text": "12.05.1978" },
        { "name": "birth_place", "text": "г. Москва" },
        { "name": "number", "text": "4509 123456" },
        { "name": "issue_date", "text": "01.01.2010" }
      ],
      "fullText": "..."
    },
    "page": "1"
  }
}
```

### 2.2 Confidence-quirk ⚠️

**Поле `confidence` присутствует на уровне Block/Line/Word, но на практике часто возвращается `0.0`** — известный сюрприз, на который жаловались интеграторы (fuse8 и др.). На уровне `entities[]` отдельного `confidence` **НЕТ**.

**Действие для нашей UI логики:** мы НЕ можем полагаться на `ocrConfidence` от API. Нужна **наша heuristic-валидация**:

- Regex по серии/номеру (`/^\d{4}\s?\d{6}$/` для РФ).
- Валидация даты (year ≤ today, > 1900).
- Sanity-check (возраст ≥ 14 для паспорта РФ).
- Длина строки имени/фамилии в реалистичных пределах.

Подсветка «сомнительное поле красным» — на основании этих heuristics, а не API confidence.

### 2.3 Распознаваемые поля

Для `passport`:
- `name`, `middle_name`, `surname`, `gender` (`male`/`female`)
- `citizenship` (ISO-3: `rus`, `blr`, `kaz`)
- `birth_date` (`DD.MM.YYYY`), `birth_place`
- `number` (серия+номер)
- `issue_date`, `expiration_date` (для загран и СНГ)

**НЕ возвращаются на уровне entities** (надо парсить fullText): код подразделения, кем выдан (issuing authority), MRZ-строки целиком.

---

## 3. Биллинг 2026

- **100 ₽ за 1000 успешных распознаваний** = **0,1 ₽ за документ** для всех моделей Vision OCR.
- Тарификация per-request. Failed requests (4xx/5xx) **не тарифицируются**.
- С 1 мая 2026 цены AI Studio **не меняются** (явное исключение в анонсе).
- **Экономика:** малый отель 20–50 номеров, 30 заселений/день → 900 запросов/мес = **90 ₽/мес**. Пренебрежимо.
- Сравнение: Контур-модуль «Распознавание паспортов» — 9 700 ₽/год = ~810 ₽/мес.

---

## 4. Errors + Latency + Quotas

### 4.1 Errors

Yandex Cloud gRPC error model:
- `400 INVALID_ARGUMENT` — некорректный base64, неподдерживаемый MIME, превышен размер.
- `401 UNAUTHENTICATED` — IAM token истёк.
- `403 PERMISSION_DENIED` — у SA нет роли `ai.vision.user`.
- `404 NOT_FOUND` — для async: операции по `operation_id` нет.
- `429 RESOURCE_EXHAUSTED` — превышена квота / RPS.
- `500 INTERNAL` / `503 UNAVAILABLE` — серверная сторона.

**Дискриминирующего кода `UNSUPPORTED_DOCUMENT` или `BLURRY_IMAGE` нет.** Если паспорт нечитаем — пустой `entities[]`. Обрабатывать на нашей стороне: «если entities.length < 4 → flag as low-quality scan».

### 4.2 Latency

В публичной документации **отсутствует**. Эмпирические репорты:
- Sync recognize паспорта: 1–3 сек на изображение ≤ 2 MB, P95 до 5 сек.
- Async PDF: ~10–30 сек на 10-страничный документ.

### 4.3 Quotas

Конкретный per-account RPS не публикуется. Default ~10 rps для Vision OCR на `recognizeText`. Для нашего объёма (≤ 1 rps пиково) — некритично.

---

## 5. Best practices в hospitality

### 5.1 Apaleo

OCR не нативный — через partner apps в Apaleo Store:
- **Abitari Kiosk** — Pro-план; «ID/Passport Scan» (требует hardware: PC/iPad-киоск + scanner).
- **Straiv** — guest-experience партнёр.
- **Roommatik** — kiosk для Испании.

Apaleo workflow: hotel регистрирует webhook на `reservation.created` → партнёр шлёт гостю pre-stay link → гость загружает фото в их UI → партнёр пишет результат обратно в Apaleo через `PATCH /reservations/{id}`.

### 5.2 Mews

Встроенный Passport Scanner в Mews Kiosk:
- Web-камера.
- MRZ-zone parsing (читает 2-3 строки в нижней части паспорта/ID-карты).

**Подтверждённые ограничения:**
- Европейские водительские права не распознаются (нет MRZ).
- Camera focus периодически отказывает → fallback на manual entry.
- При неуспешном чтении документа сканер иногда **перезаписывает имя гостя пустым значением** (баг).

**Уроки для нас:**
1. Fallback на ручной ввод обязателен.
2. **Никогда не перезаписываем поля гостя пустыми значениями** — нужен явный assertion `if (entity.text && entity.text.length > 0)`.
3. MRZ-only OCR не покроет внутренний паспорт РФ — Yandex Vision `passport` модель ценна тем, что читает шаблон, не только MRZ.

### 5.3 Российские конкуренты

- **Контур.Отель**: модуль «Распознавание сканов паспортов РФ» — **9 700 ₽/год**. Поддерживает заселение по загранпаспорту и водительским правам с 2026.
- **Bnovo**: OCR-модуля как отдельной фичи в их прайсе нет (на 2026).
- **TravelLine**: «Онлайн-регистрация» — гость заранее заполняет анкету. **OCR-сканера паспорта в стандартной поставке НЕТ** — наш потенциальный differentiator.

---

## 6. Альтернативы (нарушают canon Yandex Cloud only)

| Решение | Подход | Подходит? |
|---|---|---|
| **Yandex Vision OCR (passport)** | Cloud API, 0,1 ₽/документ, 20 стран | ✅ Канон |
| Smart Engines (Smart PassportReader) | On-premise SDK, до 55 паспортов/сек | ❌ нарушает canon; полезно знать для enterprise on-prem-фазы |
| Dbrain.io | Cloud OCR, ребрендинг 2024-2025, статус для РФ неясен | ❌ |
| ABBYY FlexiCapture | Enterprise SDK, после ухода ABBYY 2022 — через партнёров | ❌ санкционная неопределённость |

**Решение:** Yandex Vision passport — единственный соответствующий canon вариант. Smart Engines зафиксировать как fallback на enterprise-фазу (memory note).

---

## 7. 152-ФЗ и обработка биометрических данных

### 7.1 Является ли фото паспорта биометрией?

**Юридически — НЕТ.** Согласно ст. 11 152-ФЗ, биометрические ПД — это сведения, характеризующие физиологические особенности (фото лица для face-recognition). **Скан/фото страниц паспорта** — это персональные данные, но **не биометрия** (это копия документа).

→ Нам НЕ нужно письменное согласие на обработку биометрии (ст. 11 ч. 1) для нашего сценария — гость показывает паспорт камере, мы извлекаем текст, фото лица из паспорта не используем для идентификации.

**Если в будущем добавим face-match** («сравнить лицо с паспортной фотографии и live-фото гостя») — вступает биометрия → нужно письменное согласие отдельным документом. **Пока не делаем.**

### 7.2 Согласие гостя

С **1 сентября 2025** (ред. 152-ФЗ от 24.06.2025): согласие на обработку ПД должно быть **отдельным документом** (не пунктом договора, не чекбоксом «согласен с условиями»). Штраф за нарушение — до **700 000 ₽**.

Поля гостя (ФИО, паспорт, адрес, контакты) для собственно заселения **не требуют отдельного согласия** — обрабатываются на основании договора оказания гостиничных услуг (ст. 6 ч. 1 п. 5 152-ФЗ) + 109-ФЗ.

→ **Фото скана паспорта = «дополнительная обработка»**, скорее всего нужен отдельный чекбокс согласия именно на хранение фотокопии. Юридическая консультация обязательна перед прод-релизом.

### 7.3 Retention

- ПД хранятся **3 года после окончания обслуживания**.
- **30 дней** при отзыве согласия.
- Для миграционных уведомлений — собственный срок по 109-ФЗ.

**Реализация для фото паспорта в Object Storage:**
- TTL = 3 года after `booking.checkOutDate` (или дата отзыва согласия + 30 дней — что наступит раньше).
- Через S3 Lifecycle Rule на Yandex Object Storage (`Days: 1095`).
- **Лучшая практика:** после успешной отправки в ЕПГУ + N дней (90) — фото удаляется, остаются только структурированные поля.

### 7.4 Шифрование at rest

- Yandex Object Storage **по умолчанию шифрует** AES-256.
- Для passport-фото — **обязательно customer-managed KMS key** (тенант-сегрегация: один KMS-ключ на одного арендатора, чтобы при удалении тенанта rotate-and-destroy уничтожал доступ).

### 7.5 Уведомление в РКН

Любая обработка ПД в РФ требует регистрации оператора ПД в реестре РКН (`pd.rkn.gov.ru`). Это организационная процедура — должна быть выполнена до публичного запуска SaaS. **Pending для деплой-фазы.**

---

## 8. Решения для нашего mock-адаптера

### 8.1 Behaviour-faithful поведение

1. **JSON + base64 input** (строго, не multipart). Валидация base64 формата.
2. **Возвращать `confidence: 0` намеренно** в Word/Line — воспроизвести prod-quirk и протестировать наш heuristic-fallback.
3. **9 entities** для passport: surname, name, middle_name, gender, citizenship, birth_date, birth_place, number, issue_date. Все возвращать всегда (если документ валидный).
4. **Hash-based deterministic responses** — по hash(image) возвращаем фиксированный набор тестовых данных. Один и тот же файл → один и тот же результат.
5. **Edge cases** (вероятностные):
   - 3% — `400 INVALID_ARGUMENT` (некорректный base64).
   - 2% — `503 UNAVAILABLE` (имитация недоступности).
   - 5% — пустой `entities[]` (нечитаемый паспорт).
   - 7% — partial entities (только 4-6 полей, low-quality scan).
6. **Latency:** 800-2500 мс (Vision реалистично медленный).
7. **HEIC support:** возвращать `400 INVALID_ARGUMENT` на HEIC (как реальный API) — клиент должен конвертировать в JPEG.
8. **Размер:** rejection >10 MB и >20 MP — `400`.

### 8.2 Тестовые паспорта

Hardcoded набор 5-10 «тестовых» паспортов:
- Российский внутренний (Петров Иван Иванович, серия 4608 № 123456).
- Российский загран (биометрический).
- Узбекистан (для иностранного use-case + ЕПГУ flow).
- Казахстан (ЕАЭС безвизовый).
- Беларусь (без миграционной карты).

---

## 9. Открытые вопросы

1. Точная цена per-model в AI Studio (страница залочена SmartCaptcha — empirical после получения SA).
2. `expiration_date` для внутреннего паспорта РФ (формально нет даты истечения).
3. Стабильность парсинга кода подразделения и issuer authority из fullText.
4. MRZ для загранпаспорта — отдельные entities или только в fullText?
5. Latency P50/P95 — собственный benchmark.
6. Quota per-account RPS — empirical после деплоя.
7. HEIC — silently support или strict 400?
8. Поведение API при засвеченном/мятом паспорте.
9. Какой OCR-движок у Контур.Отель (publicly не раскрыто).
10. Apaleo-партнёр Abitari — какой OCR под капотом.

---

## 10. Источники (URL + дата 27.04.2026)

**Yandex AI Studio (новая локация):**
- [Vision OCR — концепции](https://aistudio.yandex.ru/docs/ru/vision/concepts/ocr/index.html)
- [Vision OCR Pricing](https://aistudio.yandex.ru/docs/ru/vision/pricing.html)
- [TextRecognition.Recognize API](https://aistudio.yandex.ru/docs/en/vision/ocr/api-ref/TextRecognition/recognize.html)
- [TextRecognitionAsync.Recognize](https://aistudio.yandex.ru/docs/en/vision/ocr/api-ref/TextRecognitionAsync/recognize.html)
- [Base64 file encoding](https://aistudio.yandex.ru/docs/en/vision/operations/base64-encode.html)
- [Yandex Cloud цены 1 мая 2026 (AI Studio исключён)](https://iiii-tech.com/about/media/news/yandex-cloud-izmenit-tseny-na-chast-servisov-s-1-maya-2026-goda/)

**OSS примеры:**
- [yandex-cloud-examples/yc-vision-ocr-recognizer](https://github.com/yandex-cloud-examples/yc-vision-ocr-recognizer)

**Hospitality-конкуренты:**
- [Контур.Отель — распознавание паспорта](https://support.kontur.ru/hotel/52155-raspoznavanie)
- [Контур.Отель — заселение по загранпаспорту/правам с 2026](https://kontur.ru/hotel/spravka/83502-zaselenie_po_zagranpasportu_i_voditelskim_pravam)
- [TravelLine — онлайн-регистрация](https://www.travelline.ru/support/knowledge-base/kak-rabotaet-onlayn-registratsiya-ili-onlayn-chekin/)
- [Apaleo Store — Abitari Kiosk](https://store.apaleo.com/apps/abitari-kiosk)
- [Mews community — Passport scanning](https://community.mews.com/mews-beta-program-43/how-do-you-scan-id-passport-in-mews-pms-900)

**Альтернативы:**
- [Smart Engines — Smart PassportReader](https://smartengines.ru/smart-passportreader/)

**Опыт интеграторов:**
- [fuse8 — Yandex Vision: распознавание (100 ₽/1000, 80% accuracy на нешаблонных)](https://fuse8.ru/articles/yandex-vision-experience)

**152-ФЗ:**
- [152-ФЗ ред. 24.06.2025](https://normativ.kontur.ru/document?moduleId=1&documentId=501173)
- [152-ФЗ ст. 11 — биометрические ПД (КонсультантПлюс)](https://www.consultant.ru/document/cons_doc_LAW_61801/7336c78762a98b5f4f698b8c3800dca1111acc16/)
- [Согласие на обработку ПД с 1 сентября 2025 — штрафы 700к (Гарант.ру)](https://www.garant.ru/article/1862510/)
