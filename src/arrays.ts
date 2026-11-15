/**
 * Growing a typed array. Every table of the codec starts at a size a normal game never fills and doubles when it
 * does; this is the one place the doubling is written.
 *
 * Sizes are not part of the packed format: a table that grows sooner or later holds the same entries.
 *
 * @interacts none (pure)
 * @deps      none
 * @complexity O(new length): one allocation and one copy
 * @alloc     the larger array; the old one is the caller's to drop
 */

/** The typed arrays the codec keeps its tables in. */
export type Table = Int32Array | Uint8Array | Uint16Array | Uint32Array | Float64Array;

/**
 * A copy of `a` with room for at least `need` entries: the length is doubled until it is enough, and the new
 * entries are zero. Callers check first that `a` is too short, so the common path never comes here.
 * @complexity O(new length) @alloc the new array
 */
export function withRoom<T extends Table>(a: T, need: number): T {
  let cap = a.length * 2 || 1;
  while (cap < need) cap *= 2;
  const grown = new (a.constructor as new (length: number) => T)(cap);
  grown.set(a);
  return grown;
}
