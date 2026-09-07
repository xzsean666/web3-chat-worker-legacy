# TASK-014: User Dual-Metadata (Public/Private JSON) & Single Avatar Storage (R2)

## Status
DONE

## Dependencies
- TASK-013

## Objectives
1. Add `public_metadata` and `private_metadata` JSON fields to `users` table.
2. Ensure strict privacy rules:
   - Only the user themselves can update their `public_metadata` and `private_metadata`.
   - Other users can only read the user's `public_metadata` via `GET /users/:address`.
   - The user themselves can read both `public_metadata` and `private_metadata` via `GET /auth/me` and `GET /users/me`.
3. Add single avatar storage support for users:
   - Upload avatar via `POST /users/me/avatar` (multipart/form-data or JSON base64).
   - Enforce single avatar constraint: uploading a new avatar replaces/overwrites the previous avatar in R2.
   - Publicly accessible avatar read endpoint: `GET /users/:address/avatar` streams the image from R2.
4. Maintain full TypeScript types and test coverage.

## Verification
- Verified with unit & integration tests in `test/users.test.ts` (5 tests passing).
- Typecheck verified with `pnpm run typecheck`.
