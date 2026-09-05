# TASK-007: Voice Message Storage (R2) & Synchronized Cleanup

## Objective
Implement voice message upload, audio streaming/download via Cloudflare R2, voice metadata in D1, and ensure dual-storage destruction deletes both the D1 record and R2 object simultaneously.

## Scope
- `POST /voice/upload`: Multipart upload of audio binary (e.g. webm/mp3/ogg), store in R2 bucket `VOICE_BUCKET`, store metadata in `voice_messages` table
- `GET /voice/:messageId`: Stream audio file from R2
- Integration with destruction service: when a voice message is deleted (via burn-on-read or manual deletion), delete from R2 and D1 together
- Size and mime-type validation

## Allowed Files
- `src/routes/voice.ts`
- `src/services/voice.ts`
- `src/services/destruction.ts`
- `src/index.ts`
- `test/voice.test.ts`
- `test/helpers/r2.ts`

## Dependencies
TASK-006

## Inputs and Outputs
- **Input**: Audio binary payload, conversation ID, duration, retention mode.
- **Output**: Created message with voice metadata, audio stream, and verified deletion of R2 object upon read.

## Acceptance Criteria
1. Uploading audio saves object to R2 under `voice/{message_id}.ext` and registers metadata in D1.
2. `GET /voice/:messageId` serves the audio binary with correct Content-Type.
3. Reading an `on_read` voice message triggers deletion of the R2 audio object AND the D1 record.
4. Subsequent calls to `GET /voice/:messageId` return HTTP 404.

## Verification Commands
- `pnpm test test/voice.test.ts`

## Risks and Assumptions
- R2 binding is injected via Worker environment context (`c.env.VOICE_BUCKET`).

## Status
DONE
