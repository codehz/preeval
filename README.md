# @codehz/preeval

Build-time pre-evaluation of `// @preeval`-marked exported `const`s. A publish-build plugin for library authors: marked initializers are evaluated once at build time and replaced with JSON literals in the emitted `dist`, so consumers get plain data in their bundle without installing this plugin.

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

Put a `// @preeval` line comment directly above a top-level exported `const`:

```ts
// @preeval
export const answer = 40 + 2

// @preeval
const label = ['a', 'b'].join('-')
export { label }
```

Rules:

- Line comment only, exact text `@preeval` (whitespace around it is trimmed).
- Must be the closest comment above the declaration; blank lines between the comment and the declaration are allowed, other comments are not.
- The declaration must be a top-level `const` that is exported — either directly (`export const x = …`) or through an `export { x }` / `export { x as y }` list. Re-exports (`export { x } from '…'`) are not supported.
- Single declarator only (`export const a = 1, b = 2` is ignored).
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
| `strict`    | `false`              | Fail the build on eval/serialize failure; default is warn + skip. |
| `allowNode` | `false`              | Explicitly acknowledge the marked module may use Node/Bun APIs. Trust-only: nothing is injected and nothing is stripped — there is no sandbox. |
| `include`   | `/\.[cm]?[jt]sx?$/`  | File-id filter passed to the bundler.                             |
| `exclude`   | `/node_modules/`     | File-id filter passed to the bundler.                             |

Only files whose source contains the literal marker string are ever inspected, and non-parseable files are ignored.

## Failure policy

- Default (`strict: false`): a failure to evaluate the module emits a warning and the transform is skipped for that module; a marked binding whose export is missing or whose value is not JSON-superset emits a warning and that binding is skipped.
- `strict: true`: the same conditions raise a build error via the bundler's `error` hook and the build fails.

## Value domain

Only JSON-superset values are accepted — values that round-trip through JSON without information loss:

- `null`, booleans, strings, finite numbers
- plain objects (prototype `Object.prototype` or `null`) and arrays, without circular references

Rejected: `undefined`, `NaN`, `±Infinity`, `bigint`, functions, symbols, `Date`, `Map`, `Set`, class instances, and circular structures.

## Requirements / caveats

- Use it on the author-side publish build (tsup, Vite, Rollup, Bun.build) — not in consumer apps.
- Marked modules are evaluated in full at build time: all top-level side effects run, so the module must stand alone (its relative imports are resolved from the temp file next to the source).
- TypeScript:
  - **Bun**: evaluates TS/TSX natively (including relative `.ts` imports).
  - **Node**: the plugin runs `sucrase` on the *entry* file only (optional `sucrase` peer). Relative TypeScript dependencies under Node need a host loader, or keep those deps as plain JS with explicit extensions.
- Prefer one-shot publish builds. Dependency modules are cached by the host ESM loader for the process lifetime; watch-mode re-eval of graphs that import shared deps is not a v1 guarantee.
- `allowNode` is an acknowledgment of trust, not isolation: evaluated code runs as-is in the host runtime (Bun or Node during build) and can already use any host API.
- No declaration-file (.d.ts) rewriting in v1 — annotated values are still typed as written in the source.
- No first-class webpack support in v1.

## How it works

1. **Detect** — the source is parsed with Babel (TS grammar for `.ts`, TSX for `.tsx`); top-level exported `const`s whose nearest preceding comment is `// @preeval` are collected (single declarator only; type-only exports ignored).
2. **Evaluate** — the whole module is written to a uniquely named temp file next to the source (kept as TS on Bun; transpiled with `sucrase` to `.mjs` on Node when needed) and loaded with a dynamic `import`; marked bindings are read off the module namespace. The temp file is removed afterwards.
3. **Replace** — each marked initializer's source span is overwritten with `JSON.stringify` of the evaluated value via magic-string, producing updated code plus a sourcemap.
