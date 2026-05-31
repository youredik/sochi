-- 2026-05-30 — AI review-reply feature (research приоритет #1,
-- project_ai_features_landscape_2026_05_30.md).
--
-- Отзывы гостей, поступающие из каналов (Островок / Авито / Яндекс Путешествия).
-- YandexGPT за один вызов размечает тональность + темы и пишет черновик ответа
-- (aiSentiment / aiTopicsJson / suggestedReply). Хозяин редактирует (hostReply)
-- и публикует (status='published', publishedAt) — ответ уходит обратно в канал
-- через ReviewPublisher seam (Mock для демо, как канал-адаптеры).
--
-- status: 'new' (пришёл, ИИ ещё не размечал) → 'drafted' (есть suggestedReply
-- /правки) → 'published'. Дедуп входящих по (channelCode, externalId).

CREATE TABLE IF NOT EXISTS channelReview (
    tenantId        Utf8 NOT NULL,
    id              Utf8 NOT NULL,
    channelCode     Utf8 NOT NULL,
    externalId      Utf8 NOT NULL,
    propertyId      Utf8 NOT NULL,
    guestName       Utf8 NOT NULL,
    ratingOverall   Int32,
    content         Utf8 NOT NULL,
    aiSentiment     Utf8,
    aiTopicsJson    Json,
    suggestedReply  Utf8,
    hostReply       Utf8,
    status          Utf8 NOT NULL,
    reviewedAt      Timestamp NOT NULL,
    aiGeneratedAt   Timestamp,
    publishedAt     Timestamp,
    createdAt       Timestamp NOT NULL,
    updatedAt       Timestamp NOT NULL,
    PRIMARY KEY (tenantId, id),
    INDEX idxChannelReviewById GLOBAL SYNC ON (id),
    INDEX idxChannelReviewExternal GLOBAL SYNC ON (channelCode, externalId)
);
