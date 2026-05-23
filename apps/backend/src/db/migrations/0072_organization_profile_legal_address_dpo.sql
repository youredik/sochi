-- 0072_organization_profile_legal_address_dpo.sql — Sprint C+ Senior P1-5 fix 2026-05-23d.
--
-- 152-ФЗ ст.9 ч.4 mandates оператор должен идентифицироваться в тексте
-- согласия. Verbatim: «наименование или ФИО и адрес оператора». Round 4
-- captured только `legalName` from Better Auth organization table — адрес
-- + DPO contact (РКН practice recommendation) не было capture path.
--
-- This migration adds 2 new columns to organizationProfile:
--   - legalAddress (string max 500) — юридический адрес оператора
--   - dpoEmail (string max 200) — DPO contact (recommended by РКН, ст.22.1)
--
-- `inn` column уже существует (0001_init) — no addition needed.
--
-- All additive — backward-compat для existing rows (default NULL).

ALTER TABLE organizationProfile
    ADD COLUMN legalAddress Utf8;

ALTER TABLE organizationProfile
    ADD COLUMN dpoEmail Utf8;
