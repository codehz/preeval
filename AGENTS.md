# Repository Guidelines

## Project Overview

`@codehz/preeval` is an **author-side publish-build plugin** that pre-evaluates configured direct calls and tagged templates of statically imported ESM functions plus `// @preeval`-marked top-level `const`s. It evaluates same-file stable dependency closures and rewrites successful targets to JSON-superset literals. Consumers get plain data without installing this package.

- Package: `@codehz/preeval` (ESM-only, MIT)
- Hosts: Vite (library mode), Rollup, Rolldown, esbuild, Bun.build via unplugin
- Not for consumer apps; no webpack support in v1

## Architecture & Data Flow

Single pipeline, shared unplugin factory, thin bundler adapters.

```
bundler (vite|rollup|rolldown|esbuild|bun)
  → unpluginFactory (src/index.ts)  // marker fast path unless automatic imports exist
    → transformPreeval (src/core/transform.ts)
        1. host-resolve rule match.from + import sources; find automatic calls/tags
        2. eval + serialize sites in macro order
        3. analyze/eval marked bindings against intermediate constants
        4. apply non-overlapping replacements + dead import cleanup
```

| Layer          | Path                                                                              | Role                                                                           |
| -------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Public factory | `src/index.ts`                                                                    | `unpluginFactory`, `preeval`, default export                                   |
| Adapters       | `src/vite.ts`, `src/rollup.ts`, `src/rolldown.ts`, `src/esbuild.ts`, `src/bun.ts` | `create*Plugin(unpluginFactory)` one-liners                                    |
| Options        | `src/types.ts`                                                                    | `Options`: `onFailure`, `rules`, `root`, `include`, `exclude`                  |
| Analyze        | `src/core/analyze/`                                                               | call/tag matching, dependency closures, evaluation plans, import cleanup plans |
| Resolve        | `src/core/resolve.ts`                                                             | host resolve binding + `SpecifierMatcher` for rule `match.from` identity       |
| Eval           | `src/core/eval.ts`                                                                | `evalExtractedModule` → `Map<localName, value>`                                |
| Serialize      | `src/core/serialize.ts`                                                           | `isJsonValue` / `serializeJson`                                                |
| Orchestrate    | `src/core/transform.ts`                                                           | `transformPreeval` + `TransformContext { warn, error, resolve? }`              |

**Failure policy**: global `onFailure` defaults to `warn`; `ignore` preserves silently, `warn` preserves with diagnostics, and `error` aborts through `ctx.error`. Automatic rules may override the policy. Configuration errors always throw. `strict` was removed.

**Eval notes**:

- Temp file: `.preeval-<pid>-<time36>-<hex><ext>` written **next to** the source so relative imports resolve; always deleted in `finally`.
- TypeScript/JSX: Bun evaluates them natively; Node delegates to a user-configured host loader such as `tsx`.
- Never use `eval()`; always dynamic `import()`.
- Extracted modules include only selected import specifiers, needed top-level const/function/class/enum declarations, synthetic targets, and optional build-time substitute imports.

## Key Directories

```
src/           # library source (edit here)
  core/
    analyze/   # types, ast, decls, closure, extract, automatic, module, cleanup
    resolve.ts / eval.ts / serialize.ts / transform.ts
  index.ts     # unplugin factory + default export
  vite|rollup|rolldown|esbuild|bun.ts
test/          # vitest; imports ../src/core/* directly (no dist)
dist/          # tsdown output (gitignored)
```

No `docs/`, `scripts/`, or CI configs.

## Development Commands

Prefer **Bun** as package manager and script runner.

```bash
bun install
bun run build          # tsdown → dist/*.js + *.d.ts
bun run test           # vitest run
bun run fmt            # oxfmt write
bun run fmt:check      # oxfmt --check
bun run lint           # oxlint
bun run lint:fix      # oxlint --fix
bun run prepublishOnly # build (hooks before publish)
```

Typecheck is implicit via editor/tsdown (`tsc` is `noEmit`). Format/lint: **oxfmt** + **oxlint** (`.oxfmtrc.json`, `.oxlintrc.json`).

## Code Conventions & Common Patterns

- **Language**: TypeScript, ESM (`"type": "module"`), `import type` required (`verbatimModuleSyntax`).
- **Naming**: `camelCase` functions/vars; `PascalCase` types; core exports `verbNoun` (`analyzePreevalModule`, `evalExtractedModule`, `transformPreeval`).
- **Async**: only at the eval/dynamic-import boundary and host module resolve for rule matching; analyze + serialize stay sync once a `SpecifierMatcher` is ready.
- **Errors**: wrap with `{ cause }`; user-facing strings start with `[preeval]`; route failures through `ignore | warn | error`.
- **Context injection**: pass a minimal `TransformContext { warn, error, resolve? }` — no DI container, no global state.
- **Filters**: prefer named regex consts (`DEFAULT_INCLUDE`, `MARKER`, `HOST_LOADER_FILE`).
- **Adapters**: keep bundler entry files as one-liner unplugin wrappers; put logic in `src/core/` or the factory.
- **Strict TS**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`; unused-locals/params intentionally off.
- **Marker / automatic scope rules** (do not loosen casually):
  - markers remain exact top-level single-declarator `const` comments
  - automatic calls/tags match by host-resolved module identity + export binding (exact source string when no host resolve)
  - direct named/default/import-alias calls/tags and static namespace properties only (`fn()`, `fn\`...\``, `ns.fn()`, `ns.fn\`...\``)
  - stable module deps only: import / const / function / class / enum
  - reject local bindings, `let`/`var`, reassignment, `this`/`arguments`/`super`, `new.target`, and `import.meta`
  - synchronous JSON-superset results only; no sandbox or purity checking
  - no whole-module fallback when extraction cannot be proven
  - no following re-exports/barrels solely because resolve landed on the same package entry unless the import source itself resolves to the rule target

## Important Files

| File                    | Why it matters                                                                 |
| ----------------------- | ------------------------------------------------------------------------------ |
| `src/index.ts`          | Public unplugin factory, filters, transform hook                               |
| `src/core/transform.ts` | Full pipeline + failure policy                                                 |
| `src/core/analyze/`     | Marker/call detection, closure plans, substitute extraction, import cleanup    |
| `src/core/eval.ts`      | Host-runtime evaluation, temp-file lifecycle, and loader-preserving extensions |
| `src/core/serialize.ts` | JSON-superset whitelist                                                        |
| `src/types.ts`          | Public `Options`                                                               |
| `package.json`          | exports map (`.`, `./vite`, `./rollup`, `./rolldown`, `./esbuild`, `./bun`)    |
| `tsdown.config.ts`      | 6 entries; `fixedExtension: false` → `.js`/`.d.ts`                             |
| `.oxfmtrc.json`         | oxfmt: single quotes, no semis, width 100                                      |
| `.oxlintrc.json`        | oxlint: correctness/suspicious + TS/import/node/vitest                         |
| `README.md`             | User-facing rules, options, value domain                                       |

## Runtime/Tooling Preferences

| Concern                    | Choice                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Package manager / lockfile | **Bun** (`bun.lock`)                                                                      |
| Dev runtime types          | `@types/bun`                                                                              |
| Publish engines            | Node `^20.19.0 \|\| >=22.12.0`                                                            |
| Build                      | **tsdown** (rolldown-based); ESM only, no CJS                                             |
| Format                     | **oxfmt** (`bun run fmt` / `fmt:check`)                                                   |
| Lint                       | **oxlint** (`bun run lint` / `lint:fix`)                                                  |
| DTS                        | `resolver: 'tsc'`, `deps.dts.neverBundle: true`, `skipLibCheck`                           |
| Plugin framework           | **unplugin** v3                                                                           |
| Parsing / rewrite          | `@babel/parser` + `@babel/traverse` + `@babel/generator` + `@babel/types`, `magic-string` |
| Node TypeScript loader     | User-configured host loader such as `tsx`; no internal transpiler                         |

Do not introduce CJS dual-package, webpack adapters, or sandboxed eval without an intentional design change.

## Testing & QA

- **Framework**: Vitest 4, zero config (`test/*.test.ts` auto-discovered).
- **Command**: `bun run test` → `vitest run`.
- **Import style**: tests hit `../src/core/*` source; no build required.
  - `test/analyze.test.ts` — unit, marker + closure extraction
  - `test/serialize.test.ts` — `isJsonValue` / `serializeJson` accept/reject tables
  - `test/eval.test.ts` — host-runtime evaluation, Bun-native TS path, and temp-file lifecycle
  - `test/transform.test.ts` — integration: real temp dirs, FS writes, dynamic imports; stub `TransformContext`
  - `test/index.test.ts` — option validation and marker/automatic filter selection
  - `test/adapters.test.ts` — rolldown/esbuild adapter factories and host smoke builds
- When changing analyze/serialize/eval/transform contracts, extend the matching test file; cover all three failure policies where behavior differs.
