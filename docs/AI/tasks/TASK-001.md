# TASK-001: Project Skeleton, TypeScript, Wrangler & Vitest Setup

## Objective
Initialize the repository with pnpm, Cloudflare Worker configuration (wrangler), TypeScript compiler setup, Hono web framework, and Vitest test harness with a health check endpoint.

## Scope
- `package.json` with dependencies (`hono`, `viem`, etc.) and devDependencies (`wrangler`, `vitest`, `typescript`, `@types/node`, etc.)
- `tsconfig.json` configured for Cloudflare Workers (ESNext, NodeNext/Bundler module resolution)
- `wrangler.jsonc` configured with D1 binding `DB` and R2 bucket binding `VOICE_BUCKET`
- `src/index.ts` with entry point Hono app and `GET /health` endpoint
- `test/health.test.ts` to verify worker execution and HTTP 200 response

## Allowed Files
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `wrangler.jsonc`
- `vitest.config.ts`
- `src/index.ts`
- `src/types.ts`
- `test/health.test.ts`

## Dependencies
None.

## Inputs and Outputs
- **Input**: None.
- **Output**: Functional Worker codebase that passes TypeScript compilation (`pnpm run typecheck`), test runner (`pnpm test`), and runs in Wrangler.

## Acceptance Criteria
1. `pnpm install` succeeds cleanly.
2. `pnpm run typecheck` passes without errors.
3. `pnpm test` runs and passes `test/health.test.ts` asserting `GET /health` returns `{"status":"ok"}`.
4. Wrangler configuration defines D1 binding `DB` and R2 bucket binding `VOICE_BUCKET`.

## Verification Commands
- `pnpm run typecheck`
- `pnpm test`

## Risks and Assumptions
- Cloudflare Workers runtime environment uses Web Standard APIs (Fetch, Request, Response, Web Crypto).
- pnpm must be used as the package manager per user rules.

## Status
DONE
