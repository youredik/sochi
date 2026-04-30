# Findings — баги/недочёты, обнаруженные в процессе записи walkthrough

Этот файл накапливает реальные баги и UX-недочёты, найденные при прогоне
полного тура `pnpm walkthrough` (signup → wizard → grid → booking lifecycle
→ folio → payment → checkout → receivables → admin/tax → admin/notifications).

Цель: не дать находкам утечь в "потом разберёмся". Каждая позиция должна
быть либо тикетом, либо явно отвергнута с обоснованием.

**Формат:**
- `[severity] [area]` Title
- Repro / контекст
- Impact (кого затрагивает)
- Suggested fix / open question

Severity: **P0** = блокирует прод, **P1** = важный UX-баг, **P2** = polish, **P3** = nice-to-have.

---

## 1. [P1] [bookings] Optimistic-band ID leak: `data-booking-id="pending_*"` placeholder читается до server-truth

**Repro:** В шахматке кликаем по пустой ячейке → заполняем гостя → клик «Создать
бронирование». Сразу после toast «Бронирование создано» band с `data-booking-id`
уже отрисован, но ID всё ещё `pending_<uuid>` — server-truth пропадает позже,
после ответа от backend.

**Impact:** Любой downstream-код (E2E-тесты, walkthrough, MCP-агенты, API-
интеграции, пользовательские расширения), который читает `data-booking-id`
сразу после создания брони, получает невалидный ID. Folio API возвращает
400 ZodError (`/^book_[26]$/`).

В этой сессии споткнулся walkthrough — пришлось обходить через
`[data-booking-id^="book_"]`. Аналогичная защита есть в `bookings.spec.ts`
(`expect(pendingBands).toHaveCount(0)`), но она была введена ad-hoc.

**Suggested fix:**
- Optimistic placeholder ставить под отдельным атрибутом `data-pending="true"`,
  а `data-booking-id` ставить ТОЛЬКО когда вернулся real `book_*` ID.
- Альтернатива: документировать паттерн `data-booking-id^="book_"` в публичном
  contract (подтянуть в API docs / мемо для интеграторов).

---

## 2. [P2] [layout] Header navigation непоследователен: «Шахматка» есть на дашборде, но нет на странице фолио

**Repro:** На `/o/{slug}/` есть карточный дашборд с 4 разделами (Шахматка / Дебиторка /
Налог / Уведомления). После перехода в фолио (`/o/{slug}/bookings/{id}/folios/{id}`)
header показывает только «Дашборд» — нет ссылки «Шахматка».

**Impact:** Администратор, оформив платёж в фолио, должен сделать ДВА клика
обратно (Дашборд → Шахматка) вместо одного. В сценарии «выезд гостя» это
лишний шаг.

**Suggested fix:** Persistent top-nav с фиксированным набором ссылок (Шахматка,
Бронирования, Дебиторка, Уведомления, Админка) — как у Apaleo / Mews. Дашборд
становится одной из ссылок, а не корнем layout-а.

---

## 3. [P1] [worker/cdc] CDC consumer для folio-creator залипает под burst-нагрузкой

**Repro:** Создал 5 бронирований через API подряд (≤500ms total). Затем 6-е
бронирование через UI. Polling `/folios` для последнего бронирования
не возвращает folio в течение 8s, нужно 12-15s до появления. С 20s deadline
работает, но запас тонкий.

**Impact:** Если отель импортирует исторические бронирования (массовый seed),
folios появятся с задержкой, и UI покажет "нет фолио" до catch-up. Чат-бот /
PMS-интеграция, ожидающие folio после `bookingCreated`, упрутся в гонку.

**Suggested fix:**
- Параллелизм: folio-creator должен иметь N=4-8 worker'ов или batch-обработку
  CDC events.
- Backpressure surface: `/folios?status=creating` или CDC offset в API, чтобы
  клиенты могли ждать catch-up детерминированно, а не магически polling-ить.
- Метрика `folio_creation_lag_seconds_p95` должна быть в observability stack
  (memory: project_observability_stack.md).

---

## 4. [P2] [wizard] Поля «Номер»/«Этаж» не auto-clear после успешного добавления номера

**Repro:** Wizard шаг 3 (Номера). Заполняем «Номер» = 101, клик «Добавить номер».
Toast «Добавлено: 1» появляется, но поле «Номер» сохраняет «101». При вводе
«102» в это же поле получаем «101102».

**Impact:** Пользователь вынужден вручную чистить поле перед каждым следующим
номером. Незаметная гадость — особенно для отелей с 20+ номерами.

В walkthrough пришлось обходить через явный `field.fill('')` перед каждым
`pressSequentially`. То же самое будет у любого реального юзера.

**Suggested fix:** При успешном добавлении номера → reset формы (form.reset() в
TanStack Form), focus снова на «Номер».

---

## 5. [P2] [folio] Status «Открыто» на фолио с нулевым балансом и проведённым платежом

**Repro:** Глава 11-12 walkthrough'а: создаём бронь → check-in → добавляем линию
проживания 5000₽ → принимаем оплату 5000₽ → возвращаемся на шахматку → выезд.
В фолио после оплаты: «Баланс к оплате 0,00 ₽», «Платежи (1)», но статус
«Открыто».

**Impact:** Не критично, но непонятно что значит «Открыто». Если фолио должно
закрыться при выезде — оно закрывается? Если автоматически нет, нужно ли
руководствоваться кнопкой «Закрыть фолио»?

**Open question:** Это design intent или missed transition? Возможно ожидание
явного «Закрыть фолио», но тогда UX должен подсказывать.

**Suggested fix (если bug):** На `bookingCheckedOut + balance == 0 + no draft
lines` → автоматически закрывать фолио. Либо явный CTA «Закрыть фолио»
выделить визуально, когда условия выполнены.

---

## 6. [P3] [dev-tooling] `pnpm dev` оставляет zombie frontend при крахе backend

**Repro:** Запустить `pnpm dev`. Backend упадёт (любой type error, ECONNREFUSED
к YDB при разрыве docker, etc) — frontend Vite остаётся жить на 5173. Следующий
`pnpm dev` падает с `Port 5173 is already in use`.

**Impact:** Локальная dev-эргономика. Каждые ~1-2 раза в день надо вручную
`lsof -ti:5173 | xargs kill`.

**Suggested fix:** В корневом `pnpm dev` объединить процессы под общим супервизором
(concurrently / npm-run-all2 с `--kill-others-on-fail`). Текущая команда
`pnpm --parallel --filter './apps/*' dev` смерть одного не убивает второй.

---

## 7. [P2] [a11y/visual] Toast в правом верхнем углу перекрывает имя организации + кнопку «Выйти»

**Repro:** Любая операция, генерирующая toast (Бронирование создано / Гость
заселён / Тариф создан...). Toast рендерится в `top-4 right-4` (Sonner
default), но HoReCa header в этом же углу — overlap.

**Impact:** Полсекунды-секунду пользователь не может кликнуть «Выйти» или
прочитать имя своей организации. Косметика, но раздражает.

**Suggested fix:** Toast → `top-16 right-4` (под header), либо header скрывает
right-side controls на время видимости toast.

---

## 8. [P3] [walkthrough self] Audio drift: wizard главы run 11s longer than narration

**Repro:** `pnpm walkthrough` log показывает: «chapter 05-wizard-rooms ran
11.1s longer than audio (audio will trail)». То есть narration кончается
раньше, чем глава завершила действия — следующая глава начинается с
озвучкой, а на видео всё ещё предыдущая.

**Impact:** Не для production-flow, но для walkthrough-видео качество страдает.
Не блокирующее.

**Suggested fix:** 2-pass запись: первый прогон без аудио, измерить фактические
длительности глав, второй проход с TTS, генерирующим аудио ровно под измеренные
длительности (или обратно — наращивать `say -r` rate, чтобы вписаться).

---

## 9. [P3] [wizard] Кнопка «Добавить номер» не меняется на «Добавить ещё» после первого добавления

**Repro:** После «Добавлено: 1» кнопка остаётся «Добавить номер». Семантически
точнее «Добавить ещё номер».

**Impact:** Микро-полировка. Не критично.

---

## 10. [P0?] [observability] Backend death silent — нет watchdog/heartbeat

**Repro:** В этой сессии backend (apps/backend на :3000) умер тихо. Frontend
держал 5173 живым. Пришлось вручную обнаружить (`curl http://localhost:8787/health`
== fail), перезапустить.

**Impact:** Production: если backend крашится в Yandex Cloud, что делает frontend?
Если он успевает отдать SPA HTML, но API дохлый, юзер видит долгие spinner-ы
до того, как поймёт «не работает».

**Suggested fix:**
- Liveness probe: `/health` endpoint (уже есть, но надо в Cloud Logging).
- Frontend: глобальный handler API-ошибок 5xx → fallback UI «сервис временно
  недоступен» вместо вечного suspense.
- Local dev: `lefthook` / `pre-commit` hook, который проверяет, что оба порта
  слушают перед `pnpm dev`-зависимыми операциями.

---

## 11. [P0?] [admin-tax/format] Подозрительно большие суммы на странице «Туристический налог»

**Repro:** Прогнал walkthrough — 6 бронирований через API+UI, тариф 5000 ₽/ночь,
8 ночей суммарно. На `/o/{slug}/admin/tax` (превью кадр `preview-final-175s.png`):

- Бронирований: **6**, Ночей: **8** ✓ (математически верно)
- Налоговая база: **400 000 000,00 ₽** ✗ (должно быть ~40 000 ₽ = 8 ночей × 5000 ₽)
- Туристический налог: **8 000 000,00 ₽** ✗ (должно быть ~800 ₽ при ставке 2%)

Расхождение порядков ~10 000× — пахнет двойным kopeck→ruble конвертом
(amountMinor отображается без деления на 100, плюс отдельно ".00 ₽" формат).

**Impact:** Если это display bug — в продакшене бухгалтер увидит 8 миллионов
налога вместо 800 рублей и закатит сцену. Если это data bug (база/ставка
действительно вычисляется неправильно) — ещё хуже, налоговая декларация
КНД 1153008 будет за миллионы.

**Open question:** Display vs data? Нужно SELECT-нуть из YDB сырые суммы и
сравнить с тем, что отдаёт `/api/v1/properties/{p}/tourism-tax-report` —
тогда ясно, где ошибка.

**Suggested fix:** Если display — `format-ru.ts:formatMoney(amountMinor)` уже
делает `/100`, нужно проверить, что endpoint реально возвращает kopecks
(canonical), а не rubles (которые потом ещё раз делятся на 100). Двойной
divide-by-100 даст ровно тот scale, что я вижу. Memory: project_payment_domain_canonical.md.

---

## 12. [P2] [layout] Header перекрывает Toast в правом верхнем углу при открытом Sheet

**Repro:** Превью кадр `preview-final-95s.png` — booking dialog открыт, в
правом верхнем углу одновременно: name «Гранд-Отель Сочи 612788» + кнопка
«Выйти» — но они EXTREMELY tonky из-за overlap с Sheet/Dialog backdrop.

**Impact:** Косметика. На headed нормально, на headless screencast выглядит
как «битая вёрстка».

**Suggested fix:** Радикально — header z-index ниже backdrop'а Dialog'а,
чтобы он сам уходил под темнотя. Или backdrop full-screen full-opacity
без щели у топа.

---

## 13. [P3] [walkthrough self] Длительности глав варьируются от 9 до 16 секунд — большой разброс

**Repro:** Просто инспекция narration durations. ch5 (9.3s) vs ch7 (15.8s vs ch3 (15.1s).
Хорошо: 12-15s — комфортный темп. Плохо: 9s — слишком быстро, не успеваешь
понять. И темп Milena зависит от длины предложения.

**Impact:** Качество TTS. Не баг продукта, но баг моего walkthrough script.

**Suggested fix:** Все narration text перенормировать на target ~14s каждое
(~140 знаков при 180 wpm). Либо `say -r 160` для медленных глав и `-r 200`
для быстрых.

---

## Как этот файл используется

1. **Каждый прогон walkthrough** → если нашёл новый баг, добавь в этот файл
   с severity и контекстом.
2. **Перед началом sprint-а** → пройтись по списку, переоценить severity,
   завести Linear/GitHub issues для P0/P1.
3. **Не fix-ить баги в walkthrough-сессии** — обходи (как с `book_*` префиксом),
   фиксирую находку здесь, чиню в отдельном branch.
4. **P3 — не обязательно фиксить.** Это «можно жить, но если будет окно — почини».
