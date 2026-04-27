-- 0027_tenant_compliance.sql — M8.A.0.1 — RU regulatory compliance fields
-- per plan v2 §7.1 #6 and research/ru-compliance-2026.md.
--
-- Closes:
--   * **Реестр КСР id** (ПП-1951, обязателен с 01.09.2025;
--     штраф 300-450к ₽ за работу без записи).
--   * **Tax regime** as constrained string (validated at service boundary
--     via Zod): NPD | USN_DOHODY | USN_DOHODY_RASHODY | PSN | OSN |
--     AUSN_DOHODY | AUSN_DOHODY_RASHODY. Existing `taxForm` остаётся
--     для обратной совместимости — будет удалён в M9 после миграции.
--   * **annual_revenue_estimate** в micro-RUB — для УСН-НДС прогноза
--     (60M ₽ порог 2026, 30M ₽ — 2027 anticipated).
--   * **Legal entity type** — IP | OOO | AO | NPD (самозанятый).
--   * **Гостевые дома (ФЗ-127 + ПП-1345 от 30.08.2025)** — флаг участия
--     в эксперименте с 1.09.2025 для kshrCategory='guest_house'.
--
-- Все поля nullable — заполняются через onboarding wizard (M8.A.0.6
-- расширит wizard step). Существующие orgs остаются с null до первого
-- редактирования профиля. APP-уровень валидация (Zod) в M8.A.0.1.tx
-- guarantee — sandboxed checks НЕ блокируют существующие orgs.
--
-- DPA уже покрыт в 0001_init.sql (`dpaVersion` + `dpaAcceptedAt` +
-- `dpaAcceptedIp`); фиксируется в onboarding wizard как обязательный
-- шаг согласия (152-ФЗ ст. 6 ч. 3).

ALTER TABLE organizationProfile ADD COLUMN ksrRegistryId Utf8;

ALTER TABLE organizationProfile ADD COLUMN ksrCategory Utf8;

ALTER TABLE organizationProfile ADD COLUMN legalEntityType Utf8;

ALTER TABLE organizationProfile ADD COLUMN taxRegime Utf8;

ALTER TABLE organizationProfile ADD COLUMN annualRevenueEstimateMicroRub Int64;

ALTER TABLE organizationProfile ADD COLUMN guestHouseFz127Registered Bool;

ALTER TABLE organizationProfile ADD COLUMN ksrVerifiedAt Timestamp;
