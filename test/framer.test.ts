import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Crc32,
  crc32,
  DEFAULT_MAGIC,
  encodeFrame,
  encodeVarint,
  MAX_VARINT_BYTES,
  readVarint,
  varintLength,
} from '../src/index.ts';

const enc = new TextEncoder();

describe('crc32', () => {
  it('matches the standard check vector and empty input', () => {
    assert.equal(crc32(enc.encode('123456789')) >>> 0, 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0x00000000);
  });

  it('supports offsets and lengths', () => {
    const data = enc.encode('xx123456789yy');
    assert.equal(crc32(data, 2, 9), 0xcbf43926);
  });

  it('incremental updates equal the one-shot digest for any split', () => {
    const data = enc.encode('the quick brown fox jumps');
    const streaming = new Crc32().update(data, 0, 7).update(data, 7, 9).update(data, 16);
    assert.equal(streaming.digest(), crc32(data));
  });
});

describe('varint', () => {
  const cases: Array<[number, number[]]> = [
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [300, [0xac, 0x02]],
    [16384, [0x80, 0x80, 0x01]],
    [Number.MAX_SAFE_INTEGER, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x0f]],
  ];

  for (const [value, bytes] of cases) {
    it(`encodes and decodes ${value}`, () => {
      const encoded = encodeVarint(value);
      assert.deepEqual([...encoded], bytes);
      assert.equal(varintLength(value), bytes.length);
      const decoded = readVarint(encoded, 0, encoded.length);
      assert.deepEqual(decoded, { ok: true, value, length: bytes.length });
    });
  }

  it('reads with an offset and limit', () => {
    const buf = Uint8Array.from([0xaa, 0x80, 0x01, 0xbb]);
    assert.deepEqual(readVarint(buf, 1, 3), { ok: true, value: 128, length: 2 });
  });

  it('reports need-more while only continuation bytes are present', () => {
    const buf = Uint8Array.from([0x80, 0x80]);
    assert.deepEqual(readVarint(buf, 0, buf.length), { ok: false, reason: 'need-more' });
    assert.deepEqual(readVarint(buf, 0, 1), { ok: false, reason: 'need-more' });
  });

  it('rejects encodings longer than 10 bytes', () => {
    const buf = new Uint8Array(MAX_VARINT_BYTES + 1).fill(0x80);
    assert.deepEqual(readVarint(buf, 0, buf.length), { ok: false, reason: 'overflow' });
  });

  it('rejects a continuation bit on the 10th byte', () => {
    const buf = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    assert.deepEqual(readVarint(buf, 0, buf.length), { ok: false, reason: 'overflow' });
  });

  it('rejects values above MAX_SAFE_INTEGER', () => {
    // 10-byte encoding with payload at shift 63 -> 2^63.
    const buf = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    assert.deepEqual(readVarint(buf, 0, buf.length), { ok: false, reason: 'overflow' });
  });

  it('accepts non-canonical zero padding up to 10 bytes', () => {
    const buf = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]);
    assert.deepEqual(readVarint(buf, 0, buf.length), { ok: true, value: 0, length: 10 });
  });

  it('encode rejects negative, fractional and unsafe integers', () => {
    assert.throws(() => encodeVarint(-1));
    assert.throws(() => encodeVarint(1.5));
    assert.throws(() => encodeVarint(Number.MAX_SAFE_INTEGER + 1));
  });
});

describe('encodeFrame', () => {
  it('lays out magic | varint length | payload | big-endian CRC32(payload)', () => {
    const payload = enc.encode('hello');
    const frame = encodeFrame(payload);

    assert.deepEqual([...frame.subarray(0, 4)], [...DEFAULT_MAGIC]);
    assert.equal(frame[4], 5);
    assert.deepEqual([...frame.subarray(5, 10)], [...payload]);
    assert.equal(
      new DataView(frame.buffer, frame.byteOffset).getUint32(10),
      crc32(payload),
    );
    assert.equal(frame.length, 4 + 1 + 5 + 4);
  });

  it('encodes empty payloads', () => {
    const frame = encodeFrame(new Uint8Array(0));
    assert.equal(frame.length, 4 + 1 + 0 + 4);
    assert.equal(frame[4], 0);
    assert.equal(new DataView(frame.buffer, frame.byteOffset).getUint32(5), 0);
  });

  it('supports a custom magic', () => {
    const frame = encodeFrame(enc.encode('x'), { magic: Uint8Array.from([0xab, 0xcd]) });
    assert.equal(frame[0], 0xab);
    assert.equal(frame[1], 0xcd);
  });

  it('returns an independent buffer', () => {
    const payload = enc.encode('mutate me');
    const frame = encodeFrame(payload);
    payload.fill(0);
    assert.deepEqual([...frame.subarray(5, 5 + 9)], [...enc.encode('mutate me')]);
  });

  it('rejects bad arguments', () => {
    assert.throws(() => encodeFrame('nope' as unknown as Uint8Array), TypeError);
    assert.throws(() => encodeFrame(new Uint8Array(0), { magic: new Uint8Array(0) }), TypeError);
  });
});
