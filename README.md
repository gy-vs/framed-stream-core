# framed-stream-core

Zero-dependency TypeScript library for a small fixed binary frame format, with
a one-shot **encoder** returning `Uint8Array` and an **incremental decoder**
that accepts arbitrarily sized chunks and yields frames as they complete.

No file, network, or command-line adapters — framing only.

## Frame layout

```
+---------+-------------------+-------------+----------+
|  magic  | varint payloadLen |  payload    | CRC-32   |
| 4 bytes | 1..N bytes        | payloadLen  | 4 bytes  |
+---------+-------------------+-------------+----------+
```

- `magic`: fixed 4-byte marker (`9d 4a 3f 21` by default, configurable).
- `payloadLen`: unsigned LEB128 varint (up to 2^53 − 1 / the configured limit).
- `payload`: `payloadLen` raw bytes.
- `CRC-32`: big-endian CRC-32/ISO-HDLC (poly `0xEDB88320`) of the payload only.

Every field may be split across input chunks; the decoder only commits a frame
after the length field and the checksum both validate.

## Usage

```ts
import { FrameEncoder, FrameDecoder } from 'framed-stream-core';

const encoder = new FrameEncoder();
const wire = encoder.encode(new TextEncoder().encode('hello'));

const decoder = new FrameDecoder(
  {
    onFrame: ({ payload }) => console.log(new TextDecoder().decode(payload)),
    onError: (err) => console.warn(err.code, err.message),
  },
  { maxPayloadLength: 16 * 1024 * 1024 },
);

decoder.write(wire.subarray(0, 3));   // any chunk size
decoder.write(wire.subarray(3));
const { clean, pendingBytes } = decoder.end(); // clean EOF vs. a half frame
```

### Error codes and resynchronization

| code               | meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `length-too-large` | declared payload length exceeds `maxPayloadLength`.            |
| `varint-overflow`  | length varint overflows the safe-integer / 64-bit structure.   |
| `crc-mismatch`     | the received checksum does not match the payload CRC.          |
| `truncated-frame`  | input ended in the middle of a frame (reported by `end()`).    |

After any frame error the decoder drops the frame's first byte and rescans to
the nearest valid magic. A byte sequence that merely *looks like* magic inside
a corrupt payload cannot produce a frame: recovery also requires its declared
length and its full CRC to validate.

### Memory behavior

Input chunks are queued and never concatenated. Confirmed prefixes (junk before
a frame, fully validated frames, and rejected frames during rescan) are
released immediately, and a mostly-spent head chunk is compacted. Retained
memory is bounded by the frame currently in flight plus uninspected input — it
does not grow with total stream history. `pendingBytes` exposes the current
retained size.

## API

- `encodeFrame(payload, options?)` / `FrameEncoder`
- `FrameDecoder(handlers?, options?)` with `write(chunk)`, `end()`, `reset()`,
  and the `pendingBytes` getter.
- `crc32(bytes)` and the `Crc32` streaming accumulator.
- `encodeVarint(n)` and the incremental `VarintReader`.

## Requirements

Node.js >= 20. TypeScript is used in strict mode; no framing or CRC
dependencies are pulled in (CRC-32 is implemented locally).

## Scripts

```sh
npm install
npm test          # node:test + tsx
npm run typecheck
npm run build     # emits dist/
```
