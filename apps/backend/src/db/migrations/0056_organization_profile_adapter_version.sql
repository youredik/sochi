-- M10 / A7.1 — adapter cache hot-reload invalidation column (D28).
--
-- Per `plans/m10_canonical.md` §2 D28 (post-audit corrected target table):
-- `tenant.adapterVersion` was originally specified, but column actually должен
-- быть на `organizationProfile` per migration 0042 mode column precedent
-- (organization is BetterAuth row, organizationProfile = HoReCa metadata).
--
-- Bumped on tenant.mode flip (demo → production OR vice-versa) → CDC event
-- → per-tenant LRU adapter cache subscribers `cache.delete(organizationId:*)`.
-- Eventual consistency ≤ TTL acceptable — no atomic flip required.

ALTER TABLE organizationProfile ADD COLUMN adapterVersion Int64;
