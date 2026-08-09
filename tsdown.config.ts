import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/vite.ts', 'src/rollup.ts', 'src/bun.ts'],
  dts: {
    // vite 8.2.1 ships types importing a non-exported helper from
    // "#types/importGlob"; tsc + skipLibCheck (already in tsconfig) tolerates
    // it. Also keep node_modules types external (unplugin pulls in vite and
    // postcss types which cannot be bundled by rolldown-plugin-dts).
    resolver: 'tsc',
    compilerOptions: {
      skipLibCheck: true,
    },
  },
  deps: {
    dts: { neverBundle: true },
  },
  // Ship .js/.d.ts (matches the exports map in package.json) instead of
  // tsdown's default .mjs/.d.mts for node platform.
  fixedExtension: false,
  clean: true,
})
