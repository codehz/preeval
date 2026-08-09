import { describe, expect, it } from 'vitest'
import { unpluginFactory } from '../src/index'

interface PluginShape {
  transform: {
    filter: {
      code?: { include: string }
    }
  }
}

function plugin(options?: Parameters<typeof unpluginFactory>[0]): PluginShape {
  const created = unpluginFactory(options, { framework: 'rollup' })
  return created as unknown as PluginShape
}

describe('unpluginFactory', () => {
  it('keeps the marker-only code filter without automatic rules', () => {
    expect(plugin().transform.filter.code).toEqual({ include: '@preeval' })
    expect(plugin({ imports: [] }).transform.filter.code).toEqual({ include: '@preeval' })
  })

  it('inspects unmarked files when automatic rules are configured', () => {
    expect(plugin({
      imports: [{ from: 'pkg', import: 'fn' }],
    }).transform.filter.code).toBeUndefined()
  })

  it('rejects malformed policies and duplicate rules immediately', () => {
    expect(() => plugin({ onFailure: 'invalid' as never })).toThrow(/onFailure/)
    expect(() => plugin(
      { strict: true } as unknown as Parameters<typeof unpluginFactory>[0],
    )).toThrow(/strict was removed/)
    expect(() => plugin({
      imports: [
        { from: 'pkg', import: 'fn' },
        { from: 'pkg', import: 'fn' },
      ],
    })).toThrow(/duplicate/)
    expect(() => plugin({
      imports: [{ from: '', import: 'fn' }],
    })).toThrow(/non-empty string/)
  })
})
