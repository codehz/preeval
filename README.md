# @codehz/preeval

Build-time pre-evaluation of `// @preeval`-marked top-level `const`s. A publish-build plugin for library authors: marked initializers are evaluated once at build time from their lexical dependency closure and replaced with JSON literals in the emitted `dist`, so consumers get plain data in their bundle without installing this plugin.

## Install

```bash
bun add -d @codehz/preeval
```

```bash
npm i -D @codehz/preeval
```

```bash
pnpm add -D @codehz/preeval
```

## Mark constants

Put a `// @preeval` line comment directly above a top-level `const` (exported or not):

```ts
// @preeval
export const answer = 40 + 2

// @preeval
const label = ['a', 'b'].join('-')
export { label }

const base = 40
// @preeval
const local = base + 2
export const out = local
```

Rules:

- Line comment only, exact text `@preeval` (whitespace around it is trimmed).
- Must be the closest comment above the declaration; blank lines between the comment and the declaration are allowed, other comments are not.
- The declaration must be a **module top-level** `const` with a single identifier declarator and an initializer. Function/block-local consts, destructuring targets, and multi-declarator declarations are ignored.
- Export is optional: `export const x`, `const x; export { x }`, and non-exported `const x` are all valid targets.
- The value must be JSON-superset (see [Value domain](#value-domain)).

## Usage

The plugin only runs during your publish build (Vite library mode, Rollup, or Bun.build). It is a no-op for consumer builds, and consumers never need it.

### Vite

```ts
import preeval from '@codehz/preeval/vite'

export default defineConfig({
  plugins: [preeval()],
})
```

### Rollup

```ts
import preeval from '@codehz/preeval/rollup'

export default {
  plugins: [preeval()],
}
```

### Bun.build

```ts
import preeval from '@codehz/preeval/bun'

await Bun.build({
  plugins: [preeval()],
})
```

## Options

| Option      | Default              | Description                                                       |
| ----------- | -------------------- | ----------------------------------------------------------------- |
| `strict`    | `false`              | Fail the build on analysis/eval/serialize failure; default is warn + skip. |
| `allowNode` | `false`              | Explicitly acknowledge the marked module may use Node/Bun APIs. Trust-only: nothing is injected and nothing is stripped — there is no sandbox. |
| `include`   | `/\.[cm]?[jt]sx?$/`  | File-id filter passed to the bundler.                             |
| `exclude`   | `/node_modules/`     | File-id filter passed to the bundler.                             |

Only files whose source contains the literal marker string are ever inspected, and non-parseable files are ignored.

## Failure policy

- Default (`strict: false`): analysis or evaluation failure emits a warning and the transform is skipped for that module; a marked binding whose value is not JSON-superset emits a warning and that binding is skipped.
- `strict: true`: the same conditions raise a build error via the bundler's `error` hook and the build fails.

## Value domain

Only JSON-superset values are accepted — values that round-trip through JSON without information loss:

- `null`, booleans, strings, finite numbers
- plain objects (prototype `Object.prototype` or `null`) and arrays, without circular references

Rejected: `undefined`, `NaN`, `±Infinity`, `bigint`, functions, symbols, `Date`, `Map`, `Set`, class instances, and circular structures.

## Requirements / caveats

- Use it on the author-side publish build (tsup, Vite, Rollup, Bun.build) — not in consumer apps.
- Evaluation runs only the **lexical dependency closure** of marked consts in the same file (imports, top-level `const`, function/class/enum declarations). Unrelated top-level statements and side-effect-only imports are not executed.
- Local dependencies must be **stable bindings**: `import`, top-level `const`, function declaration, class declaration, or `enum`. `let`/`var`, reassignment, and intervening top-level mutations of the closure are rejected (warn/error per `strict`).
- Cross-module: only the used import specifiers are kept; **imported modules still load fully** (no recursive project-graph trimming).
- TypeScript:
  - **Bun**: evaluates TS/TSX natively (including relative `.ts` imports).
  - **Node**: the plugin runs `sucrase` on the *extracted entry* only (optional `sucrase` peer). Relative TypeScript dependencies under Node need a host loader, or keep those deps as plain JS with explicit extensions.
- Prefer one-shot publish builds. Dependency modules are cached by the host ESM loader for the process lifetime; watch-mode re-eval of graphs that import shared deps is not a v1 guarantee.
- `allowNode` is an acknowledgment of trust, not isolation: extracted code runs as-is in the host runtime (Bun or Node during build) and can already use any host API. Static extraction shrinks the side-effect surface; it is not a sandbox.
- Hidden shared state from imported modules or ambient globals is outside single-file static proof and remains a documentation boundary.
- No declaration-file (.d.ts) rewriting in v1 — annotated values are still typed as written in the source.
- No first-class webpack support in v1.

## How it works

1. **Analyze** — the source is parsed with Babel (TS grammar for `.ts`, TSX for `.tsx`); top-level `const`s whose nearest preceding comment is `// @preeval` are collected (single declarator only). Their same-file lexical dependency closure is planned; only stable bindings are accepted.
2. **Extract + evaluate** — a minimal ESM module with the selected imports/declarations and synthetic exports is written next to the source (kept as TS on Bun; transpiled with `sucrase` to `.mjs` on Node when needed) and loaded with a dynamic `import`. The temp file is removed afterwards.
3. **Replace** — each marked initializer's source span is overwritten with `JSON.stringify` of the evaluated value via magic-string, producing updated code plus a sourcemap.
