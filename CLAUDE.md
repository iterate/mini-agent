---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Bun automatically loads .env, so don't use dotenv.

## Environment Variables with Doppler

This project uses [Doppler](https://doppler.com) for secrets management. **All commands that require environment variables must be prefixed with `doppler run --`**.

```bash
# Running the app with env vars
doppler run -- bun index.ts

# Running with watch mode
doppler run -- bun --watch index.ts

# Running scripts that need env vars
doppler run -- bun run start

# Type checking (no env vars needed)
bun run typecheck
```

### Required Environment Variables

The following environment variables are expected to be configured in Doppler:

| Variable | Required | Description |
|----------|----------|-------------|
| `HONEYCOMB_API_KEY` | Yes (for tracing) | API key from Honeycomb (Settings → API Keys) |
| `HONEYCOMB_ENDPOINT` | No | Defaults to `https://api.honeycomb.io` |
| `OTEL_SERVICE_NAME` | No | Defaults to `effect-tasks-cli` |
| `SERVICE_VERSION` | No | Defaults to `1.0.0` |

If `HONEYCOMB_API_KEY` is not set, the app runs without tracing (graceful degradation).

## Environment Variables with Doppler

This project uses [Doppler](https://doppler.com) for secrets management. **All commands that require environment variables must be prefixed with `doppler run --`**.

```bash
# Running the app with env vars
doppler run -- bun index.ts
```

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

<!-- effect-solutions:start -->
## Effect Solutions Usage

The Effect Solutions CLI provides curated best practices and patterns for Effect TypeScript. Before working on Effect code, check if there's a relevant topic that covers your use case.

- `effect-solutions list` - List all available topics
- `effect-solutions show <slug...>` - Read one or more topics
- `effect-solutions search <term>` - Search topics by keyword

**Local Effect Source:** The Effect repository is cloned to `~/src/github.com/Effect-TS/effect` for reference. Use this to explore APIs, find usage examples, and understand implementation details when the documentation isn't enough.
<!-- effect-solutions:end -->
