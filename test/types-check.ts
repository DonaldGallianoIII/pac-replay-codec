/**
 * Type-level check, no runtime: the hand-written types/index.d.ts must stay assignable to and from the real
 * signatures in src/index.ts. Run by the type check (`tsc -p tsconfig.json`), which fails on any drift.
 *
 * @interacts types/index.d.ts, src/index.ts (types only)
 * @deps      typescript
 * @complexity O(1)
 * @alloc     none at runtime (type-only imports)
 */
import type * as Lib from '../types/index.d.ts';
import type * as Src from '../src/index.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assignable<From, To> = [From] extends [To] ? true : false;

// The calls a user makes take the same arguments and give the same results.
// The published Prior is a smaller, opaque view of the real one, so options are compared without it, plus a
// one-way check that every real option set is a valid published one.
export const packInput: Same<Parameters<typeof Lib.packReplay>[0], Parameters<typeof Src.packReplay>[0]> = true;
export const unpackReturn: Same<ReturnType<typeof Lib.unpackReplay>, ReturnType<typeof Src.unpackReplay>> = true;
export const options: Same<Omit<Lib.PackOptions, 'prior'>, Omit<Src.PackOptions, 'prior'>> = true;
export const optionsFit: Assignable<Src.PackOptions, Lib.PackOptions> = true;
export const stats: Same<NonNullable<Lib.PackResult['stats']>, NonNullable<Src.PackResult['stats']>> = true;
// The real result fits the published one (the published one hides the coder object behind unknown).
export const result: Assignable<Src.PackResult, Lib.PackResult> = true;
export const prior: Assignable<Src.Prior, Lib.Prior> = true;
export const unpackArgs: Assignable<Parameters<typeof Src.unpackReplay>[0], Parameters<typeof Lib.unpackReplay>[0]> = true;
export const constants: Same<typeof Lib.MODE_STORED | typeof Lib.FORMAT_VERSION, number> = true;
