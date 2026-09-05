# TASK-003: EVM Wallet Authentication & Session Management

## Objective
Implement EVM wallet signature login workflow using viem for EIP-191 verification, nonce generation, session token management, and Hono authentication middleware.

## Scope
- `POST /auth/nonce`: Generate time-limited nonce challenge for a wallet address
- `POST /auth/verify`: Verify wallet signature over challenge message, create user if first time, generate session token
- `GET /auth/me`: Return authenticated user info
- `POST /auth/logout`: Revoke active session token
- Auth middleware (`src/middleware/auth.ts`) validating Bearer tokens against D1 `sessions`
- Test suite with simulated EVM private key signatures

## Allowed Files
- `src/routes/auth.ts`
- `src/middleware/auth.ts`
- `src/services/auth.ts`
- `src/index.ts`
- `test/auth.test.ts`
- `test/helpers/wallet.ts`

## Dependencies
TASK-002

## Inputs and Outputs
- **Input**: Wallet address and EIP-191 personal_sign signature.
- **Output**: Bearer session token, user record, authenticated API access.

## Acceptance Criteria
1. Nonce expires after 5 minutes and is single-use.
2. Invalid signatures or mismatched addresses return HTTP 401.
3. Valid signature creates session in D1 and returns Bearer token.
4. Protected routes reject missing/expired tokens with HTTP 401.
5. Logout deletes or invalidates the session token.

## Verification Commands
- `pnpm test test/auth.test.ts`

## Risks and Assumptions
- EVM addresses must be normalized to lower-case.
- Use `viem`'s `verifyMessage` which works seamlessly in edge runtimes.

## Status
DONE
