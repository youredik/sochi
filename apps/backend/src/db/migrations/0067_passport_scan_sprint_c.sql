-- 0067_passport_scan_sprint_c.sql — Sprint C hardening 2026-05-22.
-- Closes 5 critical findings from 5-expert review (composite verdict 5.7/10 → target 8.5/10):
--
-- 1. `photoConsentLog.textSnapshot` — exact wording shown to user (152-ФЗ ст.9 ч.4 proof).
--    Old `consentLog` (0001:438) had this column; new `photoConsentLog` (0065) regressed.
--    Без verbatim snapshot — git может быть переписан = НЕ tamper-proof для РКН.
--
-- 2. `photoConsentLog.separateConsents` (Json) — ст.10 + ст.11 multi-checkbox tracking.
--    Структура: { generalPdn: bool, citizenshipSpecial: bool, biometricPhoto: bool }.
--    Per 156-ФЗ от 24.06.2025 (vstuplenie 01.09.2025) — каждое согласие = separate atom,
--    bundled = void. Tinkoff УКБО prosecuted в 2025 за «безусловное согласие».
--
-- 3. `guestDocument` TTL 5 years — критический gap из 0066. PII основной table persist'ила
--    forever. 152-ФЗ ст.21 ч.7 + миграционное закон-во ст.21 ч.7 + ПП-9 п.10.
--    Aligns с canon Bnovo/TravelLine «auto-delete 30 days после departure» — но мы
--    берём conservative 5 лет per 152-ФЗ retention canon.
--
-- 4. `passportOcrAudit` AUTO_PARTITIONING_BY_LOAD — missed в 0066. Hot tenant partitioning.
--
-- 5. `passportOcrAudit.entitiesAnonymizedAt` — RTBF cascade tracking для 152-ФЗ ст.20
--    (10 рабочих дней). Audit row остаётся (proof что scan существовал), но PII fields
--    nullified. РКН inspection: «покажите как scrub PII после revocation» = answer есть.
--
-- ALL OPERATIONS ADDITIVE (ALTER TABLE ADD COLUMN / SET TTL / SET AUTO_PARTITIONING).
-- Безопасно для concurrent writes; YDB native ALTER non-blocking.

-- ─── 1. photoConsentLog.textSnapshot ───
-- Содержит EXACT текст согласия который был показан пользователю в момент клика.
-- Roskomnadzor inspection canon: «представьте доказательство что субъект согласился именно
-- на этот текст». Git history ≠ proof (commits can be re-written). DB row IS proof.
-- App-level INSERT всегда передаёт текст; existing rows pre-Sprint-C получают NULL → caller
-- читает из versioned dict по `version` field (fallback path).
ALTER TABLE photoConsentLog ADD COLUMN textSnapshot Utf8;

-- ─── 2. photoConsentLog.separateConsents ───
-- Json-encoded { generalPdn: bool, citizenshipSpecial: bool, biometricPhoto: bool }
-- per UX expert recommendation (Sprint C): defensive over-consent — 3 checkboxes даже
-- если photo storage-only ≠ biometric per РКН 2022 guidance. Buys insurance against
-- 2026 enforcement-year surprises (КоАП ч.16-17 биометрия = 3-18 млн ₽).
ALTER TABLE photoConsentLog ADD COLUMN separateConsents Json;

-- ─── 3. guestDocument TTL ───
-- 5 years from createdAt — 152-ФЗ ст.21 ч.7 retention + миграционное законодательство.
-- Native YDB TTL (P1825D = 5 × 365 days). Background sweep — no app cron required.
-- Existing rows старше 5 лет будут удалены при первом TTL sweep после apply (acceptable —
-- pre-Sprint-C rows минимальны, demo state).
ALTER TABLE guestDocument SET (TTL = Interval("P1825D") ON createdAt);
ALTER TABLE guestDocument SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- ─── 4. passportOcrAudit AUTO_PARTITIONING_BY_LOAD ───
-- 0066 missed это (только photoConsentLog получил). Hot tenant партиционирование.
ALTER TABLE passportOcrAudit SET (AUTO_PARTITIONING_BY_LOAD = ENABLED);

-- ─── 5. passportOcrAudit.entitiesAnonymizedAt ───
-- Timestamp когда entities были nullified для cascade revoke (ст.20 RTBF).
-- NULL = never revoked. Non-null = scrubbed at this point in time для inspection trail.
-- Audit row sам остаётся (5y TTL) — это доказательство что scan existed; PII fields
-- nullified для compliance.
ALTER TABLE passportOcrAudit ADD COLUMN entitiesAnonymizedAt Timestamp;
