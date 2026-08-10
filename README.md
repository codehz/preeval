# @codehz/preeval

Build-time pre-evaluation of marked constants and selected statically imported ESM function calls. The plugin serializes static results into the author-side publish build and can pass those payloads through explicit runtime materializers for values such as `Map`, class instances, proxies, or registration handles.

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

## Configure imported functions

Use `rules` to define an explicit match → evaluate → optional materialize pipeline:

```ts
import preeval from '@codehz/preeval/vite'

export default defineConfig({
  plugins: [
    preeval({
      rules: [
        {
          match: { from: 'message-compiler', import: 'compile' },
        },
        {
          match: { from: 'runtime-package', import: 'compile' },
          evaluate: { from: 'pure-package', import: 'compilePure' },
          materialize: { from: 'runtime-package', import: 'materialize' },
          onFailure: 'warn',
        },
      ],
    }),
  ],
})
```

`match` selects the original binding by exact source specifier and ESM export name. Matching is binding-aware and supports named imports, default imports, import aliases, and static namespace properties (`ns.fn()` / `ns['fn']()`, including the same forms as tagged-template tags). Direct calls and tagged templates are macro sites. Local aliases, re-exports/barrels, CommonJS `require`, dynamic imports, bundler-resolved IDs, and computed property expressions are not followed.

`evaluate` selects the build-time callee/tag and defaults to `match`. The evaluator receives the original call arguments or tagged-template inputs. It must return a synchronous JSON-superset payload. The evaluator import exists only in the temporary evaluation module and is never emitted.

`materialize` is an optional hard runtime boundary. A successful site emits `materialize(<serialized payload>)`; the materializer receives exactly one argument, never the original arguments or template inputs. It is imported only by the final emitted module and is never loaded or executed during pre-evaluation. Its return value may be any runtime value, including `Map`, class instances, proxies, and registration handles.

Every matched syntactic call or tagged template runs once during the build even inside a function, loop, or dead control-flow branch. Payload inputs may use literals, ambient globals, imports, stable module-level `const`/function/class/enum dependencies, and lexical bindings declared within that argument or interpolation. Captures of outer function/block bindings are rejected, as are `let`/`var`, reassigned module bindings, `this`, `arguments`, `super`, `new.target`, and `import.meta`.

If a later automatic target or marked binding depends directly or transitively on a materialized result, pre-evaluation stops at that boundary. The outer target follows its own failure policy instead of importing or executing the materializer at build time.

## Usage

The plugin only runs during your publish build (Vite library mode, Rollup, Rolldown, esbuild, or Bun.build). It is a no-op for consumer builds, and consumers never need it.

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

### Rolldown

```ts
import preeval from '@codehz/preeval/rolldown'

export default {
  plugins: [preeval()],
}
```

### esbuild

```ts
import { build } from 'esbuild'
import preeval from '@codehz/preeval/esbuild'

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  outfile: 'dist/index.js',
  plugins: [preeval()],
})
```

esbuild does not honor `enforce`. Keep this plugin ahead of other plugins that rewrite the same modules. For tsup, use `@codehz/preeval/esbuild` (default) or `@codehz/preeval/rollup` when tsup is configured for the Rollup path.

### Bun.build

```ts
import preeval from '@codehz/preeval/bun'

await Bun.build({
  plugins: [preeval()],
})
```

## Options

| Option      | Default             | Description                                                                                         |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `onFailure` | `'warn'`            | Global `ignore \| warn \| error` policy for marked bindings and automatic calls.                    |
| `rules`     | `[]`                | Explicit `match`, optional `evaluate`, optional `materialize`, and optional rule-level `onFailure`. |
| `allowNode` | `false`             | Trust acknowledgment for Node/Bun APIs. Nothing is injected or stripped; there is no sandbox.       |
| `include`   | `/\.[cm]?[jt]sx?$/` | File-id filter passed to the bundler.                                                               |
| `exclude`   | `/node_modules/`    | File-id filter passed to the bundler.                                                               |

When `rules` is empty, the plugin retains the marker-only source filter. When any automatic rule exists, every file passing `include`/`exclude` is inspected because substring filtering could miss aliased or namespace calls.

`strict` is not accepted; use `onFailure: 'error'`.

## Failure policy

- `ignore`: preserve the original failed call/tag or marked initializer and emit no diagnostic.
- `warn` (default): preserve the failed target and emit a source-located warning.
- `error`: report through the bundler error hook and abort the build.

Rule-level `onFailure` overrides the global policy only for that automatic target. Configuration errors, including malformed references, missing fields, and duplicate `match` references, always throw when the plugin is created.

Automatic targets run before marked bindings. A failed automatic target cannot be executed again through a containing marked initializer. Materialized results similarly block every outer automatic or marked closure that reaches them; unrelated marked targets continue evaluating.

## Value domain

Marked values and automatic evaluator payloads must be JSON-superset values that round-trip through JSON without information loss:

- `null`, booleans, strings, finite numbers
- plain objects (prototype `Object.prototype` or `null`) and arrays, without circular references

Rejected evaluator payloads: `undefined`, `NaN`, `±Infinity`, `bigint`, functions, symbols, `Date`, `Map`, `Set`, class instances, and circular structures. A runtime materializer's return value is not serialized and is unrestricted.

## Requirements / caveats

- Use it on the author-side publish build (tsup, Vite, Rollup, Rolldown, esbuild, Bun.build) — not in consumer apps.
- Evaluation extracts the same-file lexical dependency closure: imports and stable module-level `const`, function, class, and enum declarations. Unrelated top-level statements and side-effect-only imports are not executed.
- Calls, constructors, getters, imported-module initialization, and other side effects inside the extracted closure are allowed. Configuring a rule is an explicit trust decision; there is no purity analysis or sandbox.
- Only synchronous results are supported. Promise/thenable results are failures and are never implicitly awaited.
- Imported modules load fully. There is no recursive project-graph trimming, persistent build cache, resolved-ID matching, or bundler-resolution emulation.
- Successful automatic replacements remove their original import specifier only when the binding has no remaining runtime references. Evaluator imports exist only in temporary modules. Materializer imports are emitted only for successful surviving materialized sites and are deduplicated by exact source/export reference.
- Automatic calls use macro semantics and execute in expression/source order. Non-materialized successful results may feed later static evaluation; materialized results are runtime boundaries. A successful marked initializer takes precedence over nested non-materialized automatic edits.
- Interference checks for marked bindings are per remaining mark. A runtime-boundary-blocked mark does not prevent unrelated marks from succeeding. Never-called top-level function/class declarations are ignored unless a pre-target call site can reach them.
- TypeScript:
  - **Bun**: evaluates TS/TSX natively (including relative `.ts` imports).
  - **Node**: the plugin runs `sucrase` on the extracted entry (optional `sucrase` peer). Relative TypeScript dependencies under Node need a host loader, or plain JS dependencies with explicit extensions.
- Prefer one-shot publish builds. Imported dependency modules are cached by the host ESM loader for the process lifetime; watch-mode re-evaluation of shared graphs is not guaranteed.
- `allowNode` is an acknowledgment of trust, not isolation: extracted code can already use host APIs.
- Hidden shared state from imported modules or ambient globals remains outside single-file static proof.
- Static-analysis limits include dynamic code such as `eval(...)`/`new Function(...)`, and bundler-only virtual modules, path aliases, or package mappings that the adjacent temporary file cannot load. Failures follow `onFailure`.
- `import.meta` in an extracted closure is refused because the temporary path would leak.
- No declaration-file rewriting or first-class webpack support.

## How it works

1. **Analyze** — Babel finds configured direct import calls, tagged templates, and marked top-level constants, verifies exact binding identity, and builds stable same-file dependency closures.
2. **Extract + evaluate** — automatic sites execute children-first with `evaluate ?? match`; marked bindings then evaluate against successful non-runtime intermediate constants. Temporary ESM files are written next to the source, dynamically imported, and removed in `finally`.
3. **Serialize + emit** — evaluator payloads become literals. Rules with `materialize` emit a hygienic runtime import and `materialize(<literal>)`; other successes emit the literal directly. MagicString applies one non-overlapping final edit set and removes dead matched import bindings.
