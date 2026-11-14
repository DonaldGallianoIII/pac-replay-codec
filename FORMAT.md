# The .paczd format, version 1

Packed files are named `.paczd`. The first four bytes are still `CLRZ`, the format's working name, and tools
recognise a packed file by those bytes, not by its name. Files named `.clrz` by pre-release builds are the same
format and read the same way.

Short version: a small header, then either the original bytes or one range-coded stream. The coded stream has no
structure of its own that you can parse without the model. Unpacking means running the same model the packer ran.
The source is the full specification; this page says where to look.

All numbers are little endian. A varint is unsigned LEB128.

## Container

```
"CLRZ"          4 bytes, 43 4C 52 5A
version         u8     1
predictor set   u8     0 = schema only
                       1 = schema plus the PAC 6.11 mini-game formulas (carousel, portals, avatars)
mode            u8     0 = coded: the body is the range-coded replay
                       1 = stored: the body is the original bytes
                       2 = coded from a starting model
[prior id]      u32    only in mode 2: the crc32 of the starting model file the unpacker needs
raw length      varint size of the original file in bytes
crc32           u32    crc32 (zlib polynomial) of the original file
body            the rest of the file
```

The packer picks stored mode when the input is not a replay or when coding would not make it smaller. Every input
packs and unpacks.

For a coded body (modes 0 and 2) the unpacker refuses, before it allocates anything, a header that claims more
than 256 MB (`MAX_ORIGINAL_BYTES`) or more than 1,024 original bytes per packed byte (`EXPANSION_MAX`). The packer
stores an input that would break either limit, so every file it writes can be unpacked. Then the unpacker rebuilds
the original and checks its length and crc32 before returning it. A damaged file throws; it is never returned
wrong.

A replay whose meta block names a game version this build knows (`"game":{"version":"6.11.`) is coded once,
with predictor set 1. Any other replay (a newer or older PAC, or v7, whose recorder writes `"version":"6.11"` with
no patch number) is coded with set 0 and with set 1, and the smaller is written; a tie keeps set 0, and a set 1
pass that throws leaves set 0. The choice is in the header, so the unpacker never guesses.

Mode 2 is written only when the caller passes a starting model to `packReplay`, and none ships with this codec.
The slot is there so one can be added later without a new version byte; files packed without one stay valid.

## The input it understands

PAC's `.colreplay` container (`src/clrp.ts`):

```
"CLRP" | u8 version = 1 | u32 metaLen | meta JSON | frames | optional trailer
frame:   u8 kind (0 handshake, 1 state, 2 patch, 3 message) | varint tDelta
         state-like: varint offset | varint len | len bytes
         message:    u8 typeTag (0 number, 1 string) | type | u8 enc (0 msgpack, 1 bytes, 2 none) | [varint len | bytes]
trailer: summary JSON | u32 summaryLen | "CLTR"
```

The handshake frame carries the Colyseus type table. The codec reads it from each file, so field numbers, types
and names are never built in.

## The coded body

One adaptive binary range coder (`src/range-coder.ts`). Each context holds a 16-bit probability and a count of the
bits it has seen; the split is `(range >>> 16) * p`, the update moves `p` toward the coded bit by
`(distance * RATE[count]) >>> 16` with `RATE[n] = floor(65536 / (n + 1.5))`. Range is renormalized below 2^24,
one byte at a time, and four bytes of `low` close the stream.

On top of it:

| File | What it decides |
| --- | --- |
| `src/symbols.ts` | Bit trees for n-bit symbols, and the size-class code for integers |
| `src/strings.ts` | Strings: per-field dictionaries over one shared pool, then letters for new ones |
| `src/wire.ts` | The Colyseus schema wire grammar (schema 4 and 5) and the type table reader |
| `src/codec.ts` | The walker: which frame, which structure next, which field, the value as a change from the last one, msgpack messages, and the PAC mini-game formulas |
| `src/trig.ts` | Sine and cosine with the same bits on every engine |

Every one of these is part of the format. The settings in `TUNING` (`src/codec.ts`) are too: a file packed with
other settings does not unpack with these.

Nothing that decides a coded bit uses `Math.sin`, `Math.cos`, `Math.log2` or `**`, so a port to another language
can produce the same bytes. `test/trig-golden.json` and the format lock in `test/codec.test.ts` are the checks a
port should pass.

## Changing the format

Any change that moves the sha256 values in the format lock (`test/codec.test.ts`, `test/prior.test.ts`) is a
format change. It needs a new version byte, and the unpacker has to keep the old model to read old files.
