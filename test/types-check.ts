/**
 * Type-level check, no runtime: the hand-written types/index.d.ts, types/encode.d.ts and types/decode.d.ts must
 * stay assignable to and from the real signatures in src/index.ts, src/encode.ts and src/decode.ts. Run by the
 * type check (`tsc -p tsconfig.json`), which fails on any drift.
 *
 * @interacts types/*.d.ts, src/index.ts, src/encode.ts, src/decode.ts (types only)
 * @deps      typescript
 * @complexity O(1)
 * @alloc     none at runtime (type-only imports)
 */
import type * as Lib from '../types/index.d.ts';
import type * as Src from '../src/index.ts';
import type * as DecodeLib from '../types/decode.d.ts';
import type * as DecodeSrc from '../src/decode.ts';
import type * as EncodeLib from '../types/encode.d.ts';
import type * as EncodeSrc from '../src/encode.ts';

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
export const limits: Same<typeof Lib.MAX_ORIGINAL_BYTES | typeof Lib.EXPANSION_MAX, typeof Src.MAX_ORIGINAL_BYTES | typeof Src.EXPANSION_MAX> = true;

// The unpack-only entry: one call, the same input and result, and nothing else exported on either side.
export const decodeInput: Same<Parameters<typeof DecodeLib.unpackReplay>[0], Parameters<typeof DecodeSrc.unpackReplay>[0]> = true;
export const decodeReturn: Same<ReturnType<typeof DecodeLib.unpackReplay>, ReturnType<typeof DecodeSrc.unpackReplay>> = true;
export const decodeCall: Assignable<typeof DecodeSrc.unpackReplay, typeof DecodeLib.unpackReplay> = true;
export const decodeNames: Same<keyof typeof DecodeLib, keyof typeof DecodeSrc> = true;

// The packing entry: the same two calls as the library, with the starting-model options left out of the types.
export const encodeNames: Same<keyof typeof EncodeLib, keyof typeof EncodeSrc> = true;
export const encodeInput: Same<Parameters<typeof EncodeLib.packReplay>[0], Parameters<typeof EncodeSrc.packReplay>[0]> = true;
export const encodeOptions: Assignable<NonNullable<Parameters<typeof EncodeLib.packReplay>[1]>, EncodeSrc.PackOptions> = true;
export const encodeResult: Assignable<EncodeSrc.PackResult, EncodeLib.PackResult> = true;
export const encodeUnpack: Assignable<typeof EncodeSrc.unpackReplay, typeof EncodeLib.unpackReplay> = true;
