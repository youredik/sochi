-- M10 / A7.1 — TravelLine ID mapping per D5.
--
-- Per `plans/m10_canonical.md` §2 D5: TL is source-of-truth → roomTypeId / ratePlanId
-- come FROM TL extranet config (NOT PMS-canonical). PMS holds nullable mapping cols.
-- Mapping config-step required before adapter activation; NULL means «not yet
-- mapped» (adapter throws on push-attempt).

ALTER TABLE roomType ADD COLUMN tlRoomTypeId Utf8;
ALTER TABLE ratePlan ADD COLUMN tlRatePlanId Utf8;
