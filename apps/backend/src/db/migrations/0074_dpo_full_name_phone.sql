-- 0074_dpo_full_name_phone.sql — Sprint C+ Round 6 Legal P0 fix 2026-05-24.
--
-- 152-ФЗ ст.22 ч.3 п.7.1 (verbatim): «фамилия, имя, отчество физического лица
-- или наименование юридического лица, ответственного за организацию обработки
-- персональных данных, и номера их контактных телефонов, почтовые адреса и
-- адреса электронной почты». 0072 added только `dpoEmail` — недостаточно.
--
-- РКН ст.22.1 + practice 2026: DPO contact MUST include ФИО + email + phone +
-- postal address. Without — оператор не может правильно зарегистрироваться в
-- реестре операторов РКН (штраф ст.13.11 ч.10 = 30-50k ₽), и subject access
-- requests не имеют корректной точки контакта.
--
-- Columns added (all nullable для backward-compat existing rows):
--   - dpoFullName (Utf8) — «Иванов Иван Иванович» формат
--   - dpoPhone (Utf8) — international E.164 OR RU national (`+79991234567`)
--   - dpoPostalAddress (Utf8) — почтовый адрес для DSAR запросов
--
-- inn column из 0001 уже captures legal entity OGRN/ИНН + кешируется
-- `legalAddress` из 0072 captures org address. Эти НЕ дублируют DPO contact —
-- DPO can be different person с разным postal address.

ALTER TABLE organizationProfile
    ADD COLUMN dpoFullName Utf8;

ALTER TABLE organizationProfile
    ADD COLUMN dpoPhone Utf8;

ALTER TABLE organizationProfile
    ADD COLUMN dpoPostalAddress Utf8;
