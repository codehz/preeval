# @codehz/preeval

Build-time pre-evaluation of marked constants and selected statically imported ESM function calls. The plugin evaluates extractable expressions during an author-side publish build and replaces them with JSON-superset literals, so consumers receive plain data without this plugin or the removed function imports.

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

Use `imports` to select functions by the exact source import specifier and ESM export name:

```ts
import preeval from '@codehz/preeval/vite'

export default defineConfig({
  plugins: [preeval({
    imports: [
      { from: 'message-compiler', import: 'compile' },
      { from: 'default-package', import: 'default' },
      {
        from: 'runtime-package',
        import: 'compile',
        substitute: { from: 'pure-package', import: 'compilePure' },
        onFailure: 'warn',
      },
    ],
  })],
})
```

Matching is binding-aware and supports named imports, default imports, aliases declared in the import, and static namespace properties (`ns.fn()` / `ns['fn']()`, and the same forms as tagged-template tags). Direct call expressions and tagged templates (`fn\`...\``, `ns.fn\`...\``) are both macro sites. It does not follow local aliases, re-exports/barrels, CommonJS `require`, dynamic imports, bundler-resolved IDs, or computed property expressions.

Every matched syntactic call or tagged template is a macro site: it runs once during the build even inside a function, loop, or dead control-flow branch. Call arguments and tagged-template interpolations may use literals, ambient globals, imports, stable module-level `const`/function/class/enum dependencies, and ordinary lexical bindings declared within that argument or interpolation (for example, callback parameters and locals). Captures of function or block bindings declared outside the current argument or interpolation are rejected, as are `let`/`var`, reassigned module bindings, `this`, `arguments`, `super`, `new.target`, and `import.meta`.

`substitute` changes only the callee/tag imported by the temporary evaluation module. Original arguments and template contents are preserved, and emitted runtime code never imports or calls the substitute. Signature, export existence, equivalence, side effects, and purity are intentionally not checked.

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

| Option      | Default              | Description |
| ----------- | -------------------- | ----------- |
| `onFailure` | `'warn'`             | Global `ignore \| warn \| error` policy for marked bindings and automatic calls. |
| `imports`   | `[]`                 | Exact imported-function rules; each rule may override `onFailure` and define a build-time `substitute`. |
| `allowNode` | `false`              | Trust acknowledgment for Node/Bun APIs. Nothing is injected or stripped; there is no sandbox. |
| `include`   | `/\.[cm]?[jt]sx?$/`  | File-id filter passed to the bundler. |
| `exclude`   | `/node_modules/`     | File-id filter passed to the bundler. |

When `imports` is empty, the plugin retains the marker-only source filter. When any automatic rule exists, every file passing `include`/`exclude` is inspected because substring filtering could miss aliased or namespace calls.

`strict` was removed. Migrate `strict: true` to `onFailure: 'error'`; the old option is not accepted as a compatibility alias.

## Failure policy

- `ignore`: preserve the failed target and emit no diagnostic.
- `warn` (default): preserve the failed target and emit a source-located warning.
- `error`: report through the bundler error hook and abort the build.

Rule-level `onFailure` overrides the global policy only for that automatic call. Configuration errors, including malformed policies, missing fields, and duplicate `(from, import)` rules, always throw when the plugin is created.

Automatic calls run before marked bindings. If an automatic call inside a marked initializer fails under `ignore` or `warn`, that marked binding is skipped so marked evaluation cannot execute the original call and bypass its rule or substitute.

## Value domain

Only JSON-superset values are accepted — values that round-trip through JSON without information loss:

- `null`, booleans, strings, finite numbers
- plain objects (prototype `Object.prototype` or `null`) and arrays, without circular references

Rejected: `undefined`, `NaN`, `±Infinity`, `bigint`, functions, symbols, `Date`, `Map`, `Set`, class instances, and circular structures.

## Requirements / caveats

- Use it on the author-side publish build (tsup, Vite, Rollup, Bun.build) — not in consumer apps.
- Evaluation extracts the same-file lexical dependency closure: imports and stable module-level `const`, function, class, and enum declarations. Unrelated top-level statements and side-effect-only imports are not executed.
- Calls, constructors, getters, imported-module initialization, and other side effects inside the extracted closure are allowed. Configuring a rule is an explicit trust decision; there is no purity analysis or sandbox.
- Only synchronous results are supported. Promise/thenable results are failures and are never implicitly awaited.
- Imported modules load fully. There is no recursive project-graph trimming, persistent build cache, resolved-ID matching, or bundler-resolution emulation.
- Successful automatic replacements remove their original import specifier only when the binding has no remaining runtime references. Other specifiers remain; namespace imports remain whole while any namespace reference survives. Type-only references do not retain runtime imports.
- Automatic calls use macro semantics and execute in expression/source order. A successful marked initializer takes precedence over nested automatic edits.
- Interference checks for marked bindings are per remaining mark. Never-called top-level function/class declarations are ignored unless a pre-target call site can reach them.
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

1. **Analyze** — Babel finds configured direct import calls, tagged templates, and marked top-level constants, verifies binding identity, and builds their stable same-file dependency closures.
2. **Extract + evaluate** — automatic call/tag sites execute first in source order; marked bindings then evaluate against successful intermediate constants. Minimal ESM files are written next to the source, dynamically imported, and removed in `finally`.
3. **Serialize + replace** — JSON-superset results become literals through one non-overlapping MagicString edit set. Dead matched import bindings are removed without disturbing live specifiers.
