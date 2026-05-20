# Landing Page — Sepshn (sepshn.ru)

> ## ⛔ DEFERRED 2026-05-19
>
> Этот план **отложен до post-customer-discovery**. Стратегический pivot: landing-first → discovery-first.
>
> **Текущий активный план**: [plans/customer-discovery-plan.md](customer-discovery-plan.md)
>
> **Что строим вместо 12-секционного лендинга**: минимальный 1-экранный «credibility surface» (см. customer-discovery-plan §10).
>
> **Когда вернуться к этому плану**: после 2-3 pilot'ов и 10+ интервью — будут реальные цитаты, реальные testimonials, реальная статистика чтобы заменить research-гипотезы в копи. Скорее всего часть секций потребует переписать на основе того что реально услышали.
>
> Research-bases (3 агента 2026-05-19) остаются валидными как reference — competitor analysis + 2026 SaaS canon + Yandex SEO не устаревают.
>
> **Что НЕ потеряно**: technical foundation (routing change, Yandex.Metrika setup, Telegram-bot, 152-ФЗ юр.compliance footer) переиспользуется для минимального лендинга.

---

**Дата фиксации:** 2026-05-19 (deferred 2026-05-19)
**Brand:** Сэпшн (кириллица — UI/копи) / sepshn (latin — code/domain)
**URLs:** `sepshn.ru` (landing, apex) · `demo.sepshn.ru` (демо-инстанс)
**Audience:** владельцы малых отелей/гостевых домов/хостелов Большого Сочи (3-30 номеров), 35-55 лет, низкая tech-savvy, высокая ценовая чувствительность
**Research basis:** 3 параллельных агента 2026-05-19 — competitor PMS audit (10 сайтов) + 2026 SaaS conversion canon (Unbounce/Digital Applied/Maxio) + Yandex SEO + RU SMB copywriting

---

## §1 Стратегические решения (research-locked)

### 1.1 Главный differentiator: цена в hero

- **Никто из RU-конкурентов** (Bnovo, TravelLine, Контур.Отель, Saby, Shelter) **не показывает комиссию в hero**. Saby — единственный с открытой ценой (₽10-27k subscription). Smoobu (0.9%) + Little Hotelier (1%) делают это на international-рынке.
- **Сэпшн будет первым RU PMS с открытым «1% за бронирование» в первом экране.**

### 1.2 Free tier: до 5 номеров — бесплатно навсегда (не trial)

- Little Hotelier имеет Free Basics, но с 1% fee везде
- Никто из RU не предлагает permanent-free для маленьких объектов
- Smoobu / Cloudbeds / Mews — только trial 14-30 дней
- **Сэпшн позиционирует free как permanent → захват хвоста рынка, который никому из конкурентов не интересен**

### 1.3 Региональный якорь — Сочи

- Все RU-конкуренты national-generic. Никто не claim'ит regional foothold.
- Адлер · Красная Поляна · Сириус · Хоста · Лазаревское — конкретные топонимы в copy
- «Понимаем сезонность курортов» — defensible niche

### 1.4 Self-serve, не «менеджер перезвонит»

- Bnovo / TravelLine / Контур / Shelter всех гонят в «оставить заявку» воронку — anti-aligned с 1% commission unit economics
- Сэпшн: «зарегистрируйтесь за 30 секунд, демо-данные сразу в шахматке»
- Borrow Smoobu / Little Hotelier «no credit card required» framing

### 1.5 Mobile-first шахматка как screenshot

- Все RU-конкуренты показывают **desktop** шахматку. Никто не показывает мобильную.
- Малые отели часто работают с телефона/планшета (особенно гостевые дома).
- **Скриншот мобильного грида = differentiator**

---

## §2 Структура landing'а (12 секций, ~7-8 viewport scrolls)

### S1: Top nav (sticky)

- Logo «Сэпшн» (text-logo, Geist font)
- Текст-ссылка: «Войти»
- Primary button: «Попробовать демо» → `demo.sepshn.ru`

### S2: Hero

- **H1 (≤8 слов):** «Платите 1% за брони. Без подписки.»
- **Sub (1 предложение):** «PMS для малых отелей Сочи. Зарабатываем, когда зарабатываете вы — никаких абонентских платежей.»
- **Trigger-bar (3 буллета под sub):**
  - «До 5 номеров — бесплатно»
  - «Подключение за 1 день»
  - «Поддержка в Telegram»
- **Primary CTA (зелёная):** «Попробовать демо →» (ведёт на `demo.sepshn.ru`)
- **Secondary text-link:** «Узнать о раннем доступе →» (anchor на S11 lead form)
- **Visual:** статичный скриншот **мобильной шахматки** (16:9, AVIF/WebP ≤120KB)
- **Inline live-calculator:** «Введите комнат — N · средний чек — N₽ · загрузка — N% → ваш платёж ≈ X ₽/мес»

### S3: Property-type matrix (canonical RU)

- H2: «Подходит для»
- 5 простых иконок + 1 предложение: гостевые дома · хостелы · мини-отели · апарт-отели · бутик-отели
- Объём: одна секция, не page-flow killer

### S4: Сравнение (differentiator + SEO-magnet)

- H2: «Сравните с альтернативами»
- Таблица: Сэпшн · Bnovo · TravelLine · Контур.Отель · Saby Hotel · Excel
- 5 строк: Стоимость · Free tier · Шахматка · Mobile · Каналы (Booking/Островок/Авито)
- Только факты (закон о рекламе 38-ФЗ — без «лучше», «эффективнее»)

### S5: Что внутри (outcome-led, не feature-led)

- H2: «Что внутри»
- 6 outcome-блоков с иконками:
  - «Шахматка с мобильного» — drag-and-drop, работает offline
  - «Паспорт по фото» — сканирование Яндекс Vision, данные в системе за 5 секунд
  - «Веб-виджет для прямых броней» — без комиссии Booking
  - «Онлайн-оплаты + чеки 54-ФЗ» — встроено через ЮKassa
  - «Уведомления гостям» — Telegram + SMS
  - «Channel Manager» — в roadmap (честно: «работаем над синхронизацией с Booking / Островком / Авито»)

### S6: Trust band

- 3 коротких бейджа в строку:
  - «Работаем по 54-ФЗ»
  - «Данные хранятся в РФ (Яндекс Облако)»
  - «Соответствует 152-ФЗ»

### S7: Региональный якорь

- H2: «Сделано для отельеров Большого Сочи»
- 1-2 параграфа: понимаем сезонность курортов · команда в Сочи · можем приехать показать лично
- Список топонимов: Адлер · Красная Поляна · Сириус · Хоста · Лазаревское · Дагомыс

### S8: Pricing (открыто, не скрыто)

- H2: «Сколько это будет стоить вам»
- 2 тарифа в виде card-таблицы:
  - **Free:** ≤5 номеров, ≤30 реализованных броней/мес → 0₽
  - **Pay-as-you-go:** без лимитов → 1% от реализованных броней
- Подробный калькулятор (или reuse hero-калькулятор)
- Текст: «Без скрытых платежей. Платите только когда заработали.»

### S9: Социальное доказательство (placeholder → реальные testimonials когда будут)

- На V1 — placeholder с пометкой «уже сейчас собираем первых партнёров»
- Когда будут — фото + ФИО + название отеля + город + конкретная цифра экономии
- В коде делаем компонент с массивом, на старте — пустой массив + fallback message

### S10: FAQ (со schema.org FAQPage разметкой)

- 5 вопросов прямые ответы, без маркетинга:
  - «Сколько стоит на самом деле?»
  - «Что входит в 1%?»
  - «Как мигрировать с Bnovo / TravelLine?»
  - «Соответствует ли 152-ФЗ?»
  - «Есть ли поддержка ночью?»

### S11: Final CTA + Lead form

- H2: «Готовы попробовать?»
- 3-field form максимум:
  - Имя
  - Контакт (телефон ИЛИ Telegram — single input с placeholder)
  - Название отеля (optional)
- Checkbox 152-ФЗ согласие (незачекнут по умолчанию + ссылка на политику)
- Кнопка: «Получить ранний доступ» (зелёная)
- Подзаголовок над формой: «Перезвоним сегодня — расскажем за 5 минут»

### S12: Footer

- Юр.инфо (TBD от user'а): ООО / ИП · ИНН · ОГРН · юр.адрес
- Контакты: email · Telegram · телефон
- Ссылки: «Политика обработки персональных данных» · «Оферта» · «Cookie-policy»
- © 2026 Сэпшн

### S∞ Mobile sticky bottom CTA

- Единственная кнопка на dvh: «Попробовать демо» (всегда видна)
- WCAG 2.2 minimum 44×44 px тапа
- Hidden на desktop

---

## §3 Copy canon

- **Обращение:** «вы» строчное (НЕ «Вы» с большой)
- **Длина:** 2-3 предложения на абзац, 8-15 слов на предложение, 250-725 слов суммарно visible copy
- **Reading level:** 5-7 класс RU (Unbounce: 514% разница по конверсии vs «professional»)
- **Pronoun ratio:** «вы/ваш» доминирует, не «мы/наш»
- **Tone:** прямой, фактический, без оценочной лексики

### Триггерные слова — ИСПОЛЬЗОВАТЬ

- «без подписки» / «без скрытых платежей» / «без обучения»
- «оплата только за результат»
- «работаем по 54-ФЗ» / «соответствие 152-ФЗ»
- «русскоязычная поддержка» / «поддержка в Telegram»
- «интеграция с Островком / Суточно / Яндекс.Путешествия»

### Триггерные слова — НЕ ИСПОЛЬЗОВАТЬ

- Англицизмы: онбординг · фича · релиз · питч · MVP · workflow
- AI-buzz: «искусственный интеллект» · «нейросеть прогнозирует»
- Marketing-noise: оптимизировать · синергия · эффективное решение · инновационная платформа · трансформировать · digital
- Манипулятивное: «революция в гостиничном бизнесе» · «уникальное решение» · «единственный на рынке»

---

## §4 SEO/технический канон

### Schema.org (JSON-LD, не микроданные)

- **Organization** — name, legalName, address (Сочи), telephone, email, sameAs (VK/Telegram)
- **SoftwareApplication** — applicationCategory: BusinessApplication, operatingSystem: Web, offers (price: 0, priceCurrency: RUB для free; SubscriptionUnitPrice для commission)
- **FAQPage** — 5 Q&A из §S10

### Meta-теги

- **Title (~55 chars):** «Сэпшн — PMS для отелей и гостевых домов | 1% за бронирование»
- **Description (~150 chars):** «Платите 1% за реализованные брони, без подписки. Подходит для малых отелей, хостелов, гостевых домов. До 5 номеров — бесплатно.»
- **OG:** title, description, image (1200×630 hero), url, type=website, locale=ru_RU

### Yandex.Webmaster

- DNS TXT verification (~минуты vs HTML-файл)
- sitemap.xml с lastmod + priority (1.0 главная, 0.8 features/pricing)
- robots.txt без Crawl-Delay (Яндекс игнорирует с 2018)
- НЕ делать Турбо-страницы (deprecated apr 2025)

### Performance budget (lifts conversion +25% по Magnet 2026)

- LCP ≤2.5s
- INP ≤200ms
- CLS ≤0.1
- Hero — в initial HTML (pre-rendered), не JS-only
- Cyrillic Geist font subset (уже подключён)
- Defer Я.Метрика до interaction OR с delayHide
- Lighthouse mobile (Slow 4G): целевой score ≥90

### Долгосрочный SEO (после V1)

- 3 SEO landings cluster:
  - `/` — главная, «PMS для отеля»
  - `/programma-dlya-gostevogo-doma` — long-tail
  - `/pms-dlya-otelya-sochi` — региональная
- Перелинковка крест-накрест

---

## §5 Юр.требования (HARD, 152-ФЗ + 38-ФЗ)

### Footer обязательно

- Наименование владельца (ООО / ИП) — **TBD от user**
- ИНН + ОГРН — **TBD от user**
- Юр.адрес (текстом, не картинкой) — **TBD от user**
- Email + телефон

### Под формой обязательно

- Checkbox «Я согласен на обработку персональных данных» (незачекнут по умолчанию)
- Активная ссылка на «Политику обработки персональных данных»
- Текст: «Отправляя заявку, вы соглашаетесь с [Политикой]»

### Существующая страница

- `/privacy` уже в routes (`privacy.tsx`) — нужно проверить и адаптировать под текущий продукт (TBD)

### Risk-zones (38-ФЗ закон о рекламе)

- НЕ писать: «снижаем затраты до 30%» (без публичного кейса = штраф)
- НЕ писать: «гарантируем рост дохода» (финансовое обещание)
- НЕ писать: «#1 PMS в Сочи» (без рейтинга-источника)
- Безопасно: «1% вместо 4% у конкурентов» (проверяемо)

### Штрафы за нарушение

- Нет политики 152-ФЗ — до **700 000 руб.** для юр.лиц
- Нет реквизитов — 10-30 000 руб.

---

## §6 Что НЕ делать в V1 (анти-паттерны 2026)

| Анти-паттерн                          | Источник             | Почему                            |
| ------------------------------------- | -------------------- | --------------------------------- |
| Hero rotator / carousel               | NN/g foundational    | пользователи скипают слайды       |
| Autoplay video в hero                 | Digital Applied 2026 | LCP penalty -7%                   |
| Multi-CTA hero (>1 primary)           | Digital Applied 2026 | decision paralysis -8%            |
| Stock photo / абстракт-иллюстрация    | Digital Applied 2026 | -11% (stock) / confuse (abstract) |
| Generic «trusted by thousands»        | SaaS Hero 2026       | indistinguishable от no proof     |
| Lead form ≥6 полей                    | Brixon 2025          | 12.4% → 3.1% конверсия            |
| «Менеджер перезвонит» как primary CTA | SaaS Hero 2026       | anti-aligned с self-serve SMB     |
| Англицизмы в copy                     | RU 2026 research     | отталкивает 45-летнего владельца  |
| AI-нарратив                           | RU 2026 research     | страх неизвестного                |
| 12+ строк pricing comparison          | PipelineRoad 2026    | 3-4 строки optimum                |

---

## §7 Технический план (стек)

### Frontend

- React 19 + TanStack Router (existing app, добавить новый route)
- Tailwind 4 + shadcn-tailwind tokens (existing)
- Geist Variable Cyrillic subset (existing)
- Mobile-first responsive

### Routing

1. Удалить `apps/frontend/src/routes/_app.index.tsx` (redirect-helper)
2. Создать `apps/frontend/src/routes/index.tsx` — public route, auth-aware (если есть session — redirect на org, иначе render landing)
3. Update `welcome.tsx:39`, `signup.tsx:33`, `_app.o.$orgSlug.tsx:30` → все `to: '/'` остаются рабочими (новый `/` redirect'ит залогиненных)

### Components

- `apps/frontend/src/features/landing/landing-page.tsx` — UI всех секций
- `apps/frontend/src/features/landing/components/hero-calculator.tsx` — inline калькулятор
- `apps/frontend/src/features/landing/components/lead-form.tsx` — form с mutation
- `apps/frontend/src/features/landing/components/comparison-table.tsx` — отдельно для тестируемости
- `apps/frontend/src/features/landing/copy.ts` — все строки в одном месте (i18n-friendly future)

### Backend (Day 2)

- `apps/backend/src/domains/leads/leads.routes.ts` — POST /api/v1/leads
- `apps/backend/src/domains/leads/telegram-adapter.ts` — sendMessage forward
- Rate-limit 10/min/IP (reuse demo-inbox pattern)
- Zod validation + 152-ФЗ-aware (consent boolean required)

### Analytics

- `apps/frontend/src/lib/yandex-metrika.ts` — conditional загрузка (only if VITE_YANDEX_METRIKA_ID)
- Counter ID: **109307396** (получен 2026-05-19)
- Webvisor: enabled
- SPA route-change tracking через TanStack Router subscribe
- Goals: scroll 50%, hero CTA click, demo click, lead form submit, calculator interaction

### SEO assets

- `apps/frontend/public/sitemap.xml` (auto-generated если возможно)
- `apps/frontend/public/robots.txt`
- `apps/frontend/public/og-image.png` (1200×630)
- JSON-LD в `index.html` для статической части + dynamic для FAQ

---

## §8 TBD от user'а (не блок для Day 1 кода)

- Юр.лицо: ООО / ИП — **наименование**
- ИНН
- ОГРН
- Юр.адрес
- Email для контактов на лендинге (отдельный от твоего личного?)
- Телефон для контактов (если будет — иначе только Telegram)
- VK / Telegram-канал ссылки (если есть)
- Брендовый skein (как читается «Сэпшн» иностранно? — пока «sepshn», но если есть другой english slug — скажи)
- Логотип-иконка (если есть SVG — заменим text-logo)

Пока всё это плейсхолдеры в коде, потом замена.

---

## §9 Что после landing'а (не входит в этот scope)

1. `/programma-dlya-gostevogo-doma` + `/pms-dlya-otelya-sochi` — SEO кластер
2. Блог + контент-стратегия под Yandex behavioral signals
3. Видео-демо 60 сек (когда будут реальные клиенты — case-studies)
4. Calc widget эмбеддабельный (для партнёров)

---

## §10 Метрики успеха (после deploy)

- LCP < 2.5s (Lighthouse mobile Slow 4G)
- Lighthouse score ≥ 90
- Hero CTA click-through: целевой ≥ 25% (industry-2026 median 15-20% для SMB SaaS)
- Lead form submit: целевой ≥ 5% от unique visitors (industry median 2-4%)
- Метрика Webvisor: смотреть первые 20 сессий вручную — где спотыкаются
- Conversion to demo: целевой ≥ 30% от total visits на /

---

## Sources

3 параллельных research-агента 2026-05-19. Полные source-lists в каждом из агентских отчётов. Топ-источники:

- [Unbounce SaaS Conversion Benchmark](https://unbounce.com/conversion-benchmark-report/saas-conversion-rate/)
- [Digital Applied 2026 — 2 000 landings tested](https://www.digitalapplied.com/blog/landing-page-conversion-study-2000-pages-tested-2026)
- [Maxio 2025 SaaS Pricing Trends](https://www.maxio.com/resources/2025-saas-pricing-trends-report)
- [yandex.ru/support/webmaster/ru/schema-org](https://yandex.ru/support/webmaster/ru/schema-org/intro-schema-org)
- [stakhanovets.ru 152-ФЗ требования 2026](https://stakhanovets.ru/blog/152-fz-o-zashhite-personalnyh-dannyh-trebovaniya-i-shtrafy-v-2026-godu/)
- [bnovo.ru](https://bnovo.ru/) · [travelline.ru](https://www.travelline.ru/) · [saby.ru/hotels](https://saby.ru/hotels) (competitor empirical)
