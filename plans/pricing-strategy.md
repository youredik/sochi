# Pricing Strategy — Sochi HoReCa PMS

**Дата фиксации:** 2026-05-19
**Решение принято в сессии:** обсуждение ценообразования на старте, alternative-models research review
**Research basis:** 2026 SaaS pricing trends + RU PMS competitor pricing audit
**Memory:** `project_pricing_strategy_2026_05_19.md`

---

## §1 Решение

**Модель: pure commission, 1% от реализованной выручки. Без cap. Без разделения каналов.**

Одна фраза для лендинга: **«Платишь 1% только за реализованные брони»**.

## §2 Тарифная сетка

| Тариф             | Условия                                   | Цена                           |
| ----------------- | ----------------------------------------- | ------------------------------ |
| **Free**          | ≤ 5 комнат, ≤ 30 реализованных броней/мес | 0₽                             |
| **Pay-as-you-go** | без лимитов                               | 1% от realized booking revenue |

Hybrid (flat OR commission на выбор) **отложен**. Hybrid — премерное усложнение под несуществующий сегмент. Вернуться когда (см. §6).

## §3 База расчёта комиссии

**Считается:**

- Room revenue (тариф × ночи × количество комнат в брони)
- Только после реализации брони (гость заехал/съехал)
- Без НДС (от net-выручки отеля)
- Все каналы (direct + OTA + walk-in)

**Не считается:**

- Отменённые брони
- No-show без оплаты
- Возвраты — вычитаются из базы
- Услуги/доп.сервисы (завтраки, парковка, трансфер) — в первой версии **room-only**
- Property blocks (OOO) — не выручка

**Формула:**

```
monthly_invoice = 0.01 × Σ (realized_room_revenue_net_of_vat)
расчёт: 1-е число месяца за предыдущий
```

## §4 Биллинг

- **Способ:** monthly invoice (НЕ auto-charge с карты)
- **Причина:** ЮKassa эквайринг 2.5-2.8% сожрал бы треть комиссии. Bnovo делает так же.
- **Канал оплаты:** банковский перевод по выставленному счёту ИЛИ ЮKassa b2b-инвойс
- **Грейс-период:** 7 дней с даты выставления → soft-lock UI с возможностью оплатить, но не блок брони
- **Hard-lock:** через 30 дней неоплаты → readonly mode (брони продолжают приниматься, но без админских действий)

## §5 Регуляторика

- **54-ФЗ:** счёт за SaaS-подписку требует чек через online-кассу (ОФД) — стандарт ЮKassa B2B
- **НДС:** мы плательщики УСН на старте → счета без НДС. Когда дойдём до общего режима → отдельный пункт
- **Договор:** оферта на сайте, акцепт через checkbox при онбординге
- **Персональные данные:** клиент = ИП/юрлицо → 152-ФЗ scope = только их сотрудники-операторы, не гости (гости — ответственность отельера)

## §6 Триггеры пересмотра

Не оптимизировать заранее. Менять модель когда:

1. **Triggered: добавить cap** — первый отказ от сделки от объекта с ADR > 12 000₽ из-за «1% выходит дороже фикса конкурента»
2. **Triggered: добавить hybrid (flat-option)** — ≥ 3 customer-research интервью с фразой «хочу предсказуемый счёт, готов платить больше за стабильность»
3. **Triggered: tier OTA vs direct** — крупный отель (>30 комнат) с >70% OTA-booking-mix заявляет «не плачу комиссию с броней которые мне Booking уже забрал»
4. **Triggered: добавить per-feature add-ons** — после 20+ платящих клиентов, когда станет ясно какие фичи value-driving (channel manager, revenue management, accounting integration)

## §7 Что НЕ делать в V1

- ❌ Cap (premature optimization — целевой сегмент не нуждается)
- ❌ Per-seat (Gartner: 70% бизнесов уйдут к 2026, value-misaligned для гостиничного бизнеса)
- ❌ Per-room/month flat (Saby уже занял 300₽/комната — без явной фича-парности проигрываем ценовую войну)
- ❌ Auto-charge с карты (эквайринг съедает треть комиссии)
- ❌ Tiered features (Basic/Pro/Enterprise) — у нас одна продуктовая линейка
- ❌ Annual prepay со скидкой (cashflow vs commitment trade-off рано, сначала validate retention)
- ❌ Commission на услуги (room-only до отдельного решения)

## §8 Конкурентный контекст (2026-Q2 snapshot)

| Конкурент        | Модель                       | Эфф. ставка для 20-комн отеля с ADR 6k/занятость 60% |
| ---------------- | ---------------------------- | ---------------------------------------------------- |
| **Bnovo**        | 0.5-1% commission            | ~21 600₽/мес (1%)                                    |
| **TravelLine**   | 4% via Booking Engine + flat | ~86 400₽/мес (если 100% через BE)                    |
| **Saby Hotel**   | 300₽/комн/мес                | 6 000₽/мес                                           |
| **Контур.Отель** | flat                         | 5-15k₽/мес                                           |
| **Наш V1**       | 1% commission                | ~21 600₽/мес                                         |

**Позиционирование:** на уровне Bnovo по цене, превосходим по UX (PWA, offline, мобильный grid). Бьём TravelLine в 4 раза по цене. Дороже Saby — но Saby = bare-bones, мы = full PMS с channel manager.

## §9 Метрики для мониторинга

После запуска платных тарифов отслеживать:

- **MRR** (предсказуемая часть) vs **commission revenue** (variable)
- **ARPA** (Average Revenue Per Account) — должен расти с сезонностью
- **Cost-to-serve per tenant** — Yandex Cloud Functions + YDB Serverless cost / tenant
- **Net margin per tenant** = (commission - ЮKassa fees - cloud cost) / commission
- **Churn rate** разделить по сегментам ADR (защищаем ли мы high-ADR без cap)
- **Conversion free → paid** — когда отель пересекает 30 броней/мес

Целевая unit-economics: **net margin ≥ 70%** от commission revenue после всех cloud + acquiring costs (благодаря serverless idle-cost ≈ 0).

---

## Дальнейшие шаги (не блокеры запуска)

1. Калькулятор unit-economics в `docs/` с реальными цифрами Yandex Cloud
2. Pricing-страница на лендинге с одним блоком и «как считается» FAQ
3. Backend: tracking realized_booking_revenue per tenant per month (вероятно уже есть в booking domain)
4. Backend: monthly invoice generation job (cron + ЮKassa B2B API)
5. Frontend: usage dashboard для клиента (текущий месяц = X броней × Y₽ = Z₽ к оплате)
