import { describe, expect, it } from 'vitest'
import { isJsonValue, serializeJson } from '../src/core/serialize'

describe('serialize', () => {
  describe.each([
    ['null', null],
    ['true', true],
    ['false', false],
    ['zero', 0],
    ['negative', -1],
    ['finite float', 3.5],
    ['string', 'text'],
    ['plain object', { a: 1, b: 'two', c: null }],
    ['null-prototype object', Object.assign(Object.create(null), { a: 1 })],
    ['array', [1, 'a', null, { b: true }]],
    ['nested', { nested: { arr: [1, { x: 2 }] } }],
  ])('accepts %s', (_label, value) => {
    it('is a JSON value and serializes to a parseable JSON string', () => {
      expect(isJsonValue(value)).toBe(true)
      const s = serializeJson(value)
      expect(typeof s).toBe('string')
      expect(JSON.parse(s)).toEqual(value)
    })
  })

  describe.each([
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['bigint', 1n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['Set', new Set([1])],
    ['class instance', new (class Foo {})()],
  ])('rejects %s', (_label, value) => {
    it('is not a JSON value and serializeJson throws', () => {
      expect(isJsonValue(value)).toBe(false)
      expect(() => serializeJson(value)).toThrow(TypeError)
    })
  })

  it('rejects circular structures', () => {
    const obj: Record<string, unknown> = {}
    obj.self = obj
    expect(isJsonValue(obj)).toBe(false)
    expect(() => serializeJson(obj)).toThrow(TypeError)

    const arr: unknown[] = [1]
    arr.push(arr)
    expect(isJsonValue(arr)).toBe(false)
    expect(() => serializeJson(arr)).toThrow(TypeError)
  })

  it('returns a JSON string for accepted values', () => {
    expect(serializeJson({ a: 1, b: [true, null, 'x'] })).toBe('{"a":1,"b":[true,null,"x"]}')
    expect(serializeJson(42)).toBe('42')
    expect(serializeJson('hi')).toBe('"hi"')
    expect(serializeJson(null)).toBe('null')
  })
})
