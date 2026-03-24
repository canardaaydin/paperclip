# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Paperclip

Paperclip is an open-source control plane for AI-agent companies. It orchestrates agent teams with org structures, task management, cost tracking, approval gates, and governance. One instance can run multiple companies with complete data isolation.

## Commands

```sh
pnpm install              # Install all dependencies
pnpm dev                  # Start API + UI with file watching (hot reload)
pnpm dev:once             # Start API + UI without file watching
pnpm dev:server           # Server only
pnpm dev:ui               # UI only
pnpm build                # Build all packages
pnpm typecheck            # TypeScript type checking (alias: pnpm -r typecheck)
pnpm test:run             # Run Vitest test suite
pnpm test:e2e             # Run Playwright E2E tests
pnpm db:generate          # Generate Drizzle migration after schema change
pnpm db:migrate           # Apply pending migrations
```

Run a single test file: `pnpm vitest run path/to/file.test.ts`

### Verification before hand-off

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

## Monorepo Structure

- **`server/`** — Express REST API and orchestration services
- **`ui/`** — React 19 + Vite + TailwindCSS 4.0 dashboard
- **`cli/`** — NPX CLI for onboarding/configuration
- **`packages/db/`** — Drizzle ORM schema, migrations, DB clients
- **`packages/shared/`** — Shared types, Zod validators, API path constants
- **`packages/adapter-utils/`** — Utilities for building adapters
- **`packages/adapters/`** — LLM provider adapters (claude, codex, cursor, gemini, etc.)
- **`packages/plugins/`** — Plugin SDK, scaffolder, and examples
- **`doc/`** — Product specs, architecture docs, dated plan docs
- **`tests/`** — Playwright E2E tests

## Architecture

### Key layers and data flow

1. **`packages/db`** — Schema definitions (Drizzle) and exported types
2. **`packages/shared`** — API types, Zod validators, constants shared across layers
3. **`server`** — Routes (`server/src/routes/`) and services (`server/src/services/`)
4. **`ui`** — React pages, API client hooks (React Query), components

When changing schema or API behavior, **all four layers must stay synchronized**.

### Database

- Embedded PostgreSQL (PGlite) is used in dev when `DATABASE_URL` is unset
- Data persists at `~/.paperclip/instances/default/db/`
- Reset dev DB: `rm -rf data/pglite && pnpm dev`
- Schema lives in `packages/db/src/schema/*.ts` — new tables must be exported from `packages/db/src/schema/index.ts`
- Migration generation reads compiled schema from `dist/schema/*.js` so `packages/db` is compiled first

### Database change workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. `pnpm db:generate`
4. `pnpm -r typecheck`

### API conventions

- Base path: `/api`
- Auth: board access (full operator), agent access (bearer API keys, hashed at rest)
- All entities are company-scoped; enforce company boundaries in routes/services
- Write activity log entries for all mutations
- Return consistent HTTP errors: 400/401/403/404/409/422/500
- WebSocket realtime events at `/ws/live-events`

### Control-plane invariants (must be preserved)

- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

## Key docs

- `doc/SPEC-implementation.md` — V1 build contract (source of truth for current implementation target)
- `doc/PRODUCT.md` — Product definition (companies, agents, tasks)
- `doc/DEVELOPING.md` — Development setup and workflow
- `doc/DATABASE.md` — Database setup options
- `AGENTS.md` — Engineering rules and definitions of done
- `CONTRIBUTING.md` — PR conventions including "thinking path" format

## Lockfile policy

Do not commit `pnpm-lock.yaml` in pull requests. GitHub Actions owns it and regenerates on pushes to `master`.

## Plan docs

New plan documents belong in `doc/plans/` with `YYYY-MM-DD-slug.md` filenames. Do not replace strategic docs (`doc/SPEC.md`, `doc/SPEC-implementation.md`) wholesale — prefer additive updates.
