# Repository Guidelines

## Project Overview

`@codehz/preeval` is an **author-side publish-build plugin** that pre-evaluates `// @preeval`-marked top-level exported `const`s at build time and rewrites their initializers to JSON literals in `dist`. Consumers get plain data without installing this package.

- Package: `@codehz/preeval` (ESM-only, MIT)
- Hosts: Vite (library mode), Rollup, Bun.build via unplugin
- Not for consumer apps; no webpack support in v1

## Architecture & Data Flow

Single pipeline, shared unplugin factory, thin bundler adapters.

```
bundler (vite|rollup|bun)
  → unpluginFactory (src/index.ts)  // enforce: 'pre', filter id + code contains '@preeval'
    → transformPreeval (src/core/transform.ts)
        1. detectMarkedExports  // Babel AST: // @preeval above exported const
        2. evalModuleExports    // temp file next to source + dynamic import
        3. serializeJson        // JSON-superset only
        4. MagicString.overwrite(init spans) + sourcemap
```

| Layer | Path | Role |
| --- | --- | --- |
| Public factory | `src/index.ts` | `unpluginFactory`, `preeval`, default export |
| Adapters | `src/vite.ts`, `src/rollup.ts`, `src/bun.ts` | `create*Plugin(unpluginFactory)` one-liners |
| Options | `src/types.ts` | `Options`: `strict`, `allowNode`, `include`, `exclude` |
| Detect | `src/core/detect.ts` | `detectMarkedExports` → `MarkedBinding[]` |
| Eval | `src/core/eval.ts` | `evalModuleExports` → `Map<localName, value>` |
| Serialize | `src/core/serialize.ts` | `isJsonValue` / `serializeJson` |
| Orchestrate | `src/core/transform.ts` | `transformPreeval` + `TransformContext { warn, error }` |

**Failure policy** (everywhere): `strict: true` → `ctx.error` + throw; default → `ctx.warn` + skip binding / return `null` for the module. Messages are prefixed `[preeval]`.

**Eval notes**:
- Temp file: `.preeval-<pid>-<time36>-<hex><ext>` written **next to** the source so relative imports resolve; always deleted in `finally`.
- Bun: native TS/TSX; Node: optional peer `sucrase` transpiles **entry only** → `.mjs`.
- `allowNode` is trust-only (currently a no-op via `void options.allowNode`); no sandbox.
- Never use `eval()`; always dynamic `import()`.

## Key Directories

```
src/           # library source (edit here)
  core/        # detect / eval / serialize / transform
  index.ts     # unplugin factory + default export
  vite|rollup|bun.ts
test/          # vitest; imports ../src/core/* directly (no dist)
dist/          # tsdown output (gitignored)
```

No `docs/`, `scripts/`, CI, or lint/format configs.

## Development Commands

Prefer **Bun** as package manager and script runner.

```bash
bun install
bun run build          # tsdown → dist/*.js + *.d.ts
bun run test           # vitest run
bun run prepublishOnly # build (hooks before publish)
```

There is no lint/format/coverage script. Typecheck is implicit via editor/tsdown (`tsc` is `noEmit`).

## Code Conventions & Common Patterns

- **Language**: TypeScript, ESM (`"type": "module"`), `import type` required (`verbatimModuleSyntax`).
- **Naming**: `camelCase` functions/vars; `PascalCase` types; core exports `verbNoun` (`detectMarkedExports`, `evalModuleExports`, `transformPreeval`).
- **Async**: only at the eval/dynamic-import boundary; detect + serialize are sync.
- **Errors**: wrap with `{ cause }`; user-facing strings start with `[preeval]`; dual-path strict vs warn.
- **Context injection**: pass a minimal `TransformContext { warn, error }` — no DI container, no global state.
- **Filters**: prefer named regex consts (`DEFAULT_INCLUDE`, `MARKER`, `TS_FILE`).
- **Adapters**: keep bundler entry files as one-liner unplugin wrappers; put logic in `src/core/` or the factory.
- **Strict TS**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; unused-locals/params intentionally off.
- **Marker rules** (do not loosen casually): line comment only, exact `@preeval` (trim whitespace), nearest comment above, top-level single-declarator exported `const`, no re-exports, value must be JSON-superset.

## Important Files

| File | Why it matters |
| --- | --- |
| `src/index.ts` | Public unplugin factory, filters, transform hook |
| `src/core/transform.ts` | Full pipeline + failure policy |
| `src/core/detect.ts` | Marker / export detection contract |
| `src/core/eval.ts` | Bun vs Node prep, sucrase peer, temp-file lifecycle |
| `src/core/serialize.ts` | JSON-superset whitelist |
| `src/types.ts` | Public `Options` |
| `package.json` | exports map (`.`, `./vite`, `./rollup`, `./bun`) |
| `tsdown.config.ts` | 4 entries; `fixedExtension: false` → `.js`/`.d.ts` |
| `README.md` | User-facing rules, options, value domain |

## Runtime/Tooling Preferences

| Concern | Choice |
| --- | --- |
| Package manager / lockfile | **Bun** (`bun.lock`) |
| Dev runtime types | `@types/bun` |
| Publish engines | Node `^20.19.0 \|\| >=22.12.0` |
| Build | **tsdown** (rolldown-based); ESM only, no CJS |
| DTS | `resolver: 'tsc'`, `deps.dts.neverBundle: true`, `skipLibCheck` |
| Plugin framework | **unplugin** v3 |
| Parsing / rewrite | `@babel/parser`, `magic-string` |
| Optional peer | `sucrase` ^3 (Node TS eval only) |

Do not introduce CJS dual-package, webpack adapters, or sandboxed eval without an intentional design change.

## Testing & QA

- **Framework**: Vitest 4, zero config (`test/*.test.ts` auto-discovered).
- **Command**: `bun run test` → `vitest run`.
- **Import style**: tests hit `../src/core/*` source; no build required.
  - `test/detect.test.ts` — unit, inline source strings, span offsets
  - `test/serialize.test.ts` — `isJsonValue` / `serializeJson` accept/reject tables
  - `test/eval.test.ts` — Node-path force via `runtime.isBun: false` (sucrase); Bun default path
  - `test/transform.test.ts` — integration: real temp dirs, FS writes, dynamic imports; stub `TransformContext`
- When changing detect/serialize/eval/transform contracts, extend the matching test file; keep failure-policy cases for both `strict` and default paths.
