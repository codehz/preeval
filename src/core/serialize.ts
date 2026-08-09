/**
 * JSON-superset serialization helpers.
 *
 * Only values that round-trip through JSON without information loss are
 * accepted: null, booleans, finite numbers, strings, plain objects (prototype
 * `Object.prototype` or `null`) and arrays. Everything else — undefined, NaN,
 * ±Infinity, bigint, function, symbol, Date, Map, Set, class instances and
 * circular structures — is rejected.
 */

type JsonContainer = Record<string, unknown> | unknown[]

function check(value: unknown, stack: WeakSet<object>): boolean {
  if (value === null) return true
  const t = typeof value
  if (t === 'boolean' || t === 'string') return true
  if (t === 'number') return Number.isFinite(value)
  if (t !== 'object') return false

  // Circular reference: the value is an ancestor of itself.
  if (stack.has(value as object)) return false
  stack.add(value as object)
  try {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!check(item, stack)) return false
      }
      return true
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!check((value as Record<string, unknown>)[key], stack)) return false
    }
    return true
  } finally {
    stack.delete(value as object)
  }
}

/** True when `value` is a JSON superset value (serializable without loss). */
export function isJsonValue(value: unknown): boolean {
  return check(value, new WeakSet())
}

/**
 * Serialize `value` to a JSON string. Throws when the value is not a JSON
 * superset value (see {@link isJsonValue}).
 */
export function serializeJson(value: unknown): string {
  if (!isJsonValue(value)) {
    throw new TypeError(
      'preeval: value is not JSON-serializable (only null, booleans, finite numbers, strings, plain objects and arrays without circular references are supported)',
    )
  }
  return JSON.stringify(value)
}
