# Empirical evidence: real Yandex Vision API vs MockVisionOcr

Per `feedback_empirical_mock_verification.md` — when sandbox API is reachable,
empirical curl-verification is REQUIRED before claiming Mock 100% совпадает.

## Status (2026-04-28)

- ❌ **NOT yet empirically verified.** MockVisionOcr written by research-cache.
- ✅ Verification script exists: `scripts/verify-vision-empirical.ts`
- ⏳ Awaits user run with real Yandex Cloud credentials
  (YC_API_KEY + YC_FOLDER_ID) to populate `real-vision-response.json`.

## Files (populated after script run)

  - `real-vision-response.json` — captured response от настоящего Yandex
    Vision passport endpoint (per script output)
  - `mock-vision-response.json` — same input → MockVisionOcr response
    (для diff comparison)
  - `real-vision-error.json` — error path output (404/401/429/5xx)

## Next action

Run from project root:

```bash
YC_API_KEY=<your-key> YC_FOLDER_ID=<your-folder> \
  node --env-file-if-exists=.env scripts/verify-vision-empirical.ts \
  [path/to/test-passport.jpg]
```

Then diff the JSON outputs; patch `mock-vision.ts` to match real contract;
commit "empirical-verified against Yandex Vision YYYY-MM-DD".

## Cost

~0.05₽ per call (Yandex Vision pricing 2026-04). 1 call per verification run.
