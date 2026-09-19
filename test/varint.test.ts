import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VarintReader, encodeVarint } from '../src/varint.js';

function decode(bytes: number[] | Uint8Array) {
  const reader = new VarintReader();
  for (const b of bytes) reader.push(b);
  return reader.state;
}

test('encodeVarint: canonical small values', () => {
  assert.deepEqual([...encodeVarint(0)], [0x00]);
  assert.deepEqual([...encodeVarint(1)], [0x01]);
  assert.deepEqual([...encodeVarint(127)], [0x7f]);
  assert.deepEqual([...encodeVarint(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeVarint(300)], [0xac, 0x02]);
  assert.deepEqual([...encodeVarint(16384)], [0x80, 0x80, 0x01]);
});

test('VarintReader: round-trips values up to MAX_SAFE_INTEGER, byte by byte', () => {
  const values = [
    0n,
    1n,
    127n,
    128n,
    300n,
    16383n,
    16384n,
    2n ** 32n - 1n,
    2n ** 32n,
    2n ** 49n - 1n,
    2n ** 49n,
    BigInt(Number.MAX_SAFE_INTEGER),
  ];
  for (const v of values) {
    const bytes = encodeVarint(Number(v));
    // Feed one byte at a time and check intermediate states.
    const reader = new VarintReader();
    for (let i = 0; i < bytes.length; i++) {
      reader.push(bytes[i]!);
      const state = reader.state;
      assert.equal(state.complete, i === bytes.length - 1, `value ${v} byte ${i}`);
      assert.equal(state.bytes, i + 1);
      assert.equal(state.error, undefined);
    }
    assert.equal(decode(bytes).value, Number(v));
  }
});

test('VarintReader: accepts non-minimal encodings within the value range', () => {
  // 0 encoded over two bytes: 0x80 0x00
  assert.equal(decode([0x80, 0x00]).value, 0);
  assert.equal(decode([0xff, 0x01]).value, 255);
});

test('VarintReader: digit at shift 49 above 0x0f overflows the safe range', () => {
  // 2^53 encoded: ... digit 0x10 at the 8th byte (shift 49)
  const bytes = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10, 0x00];
  assert.equal(decode(bytes).error, 'overflow');
});

test('VarintReader: non-zero 9th byte (shift 56) overflows', () => {
  const bytes = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
  assert.equal(decode(bytes).error, 'overflow');
});

test('VarintReader: non-zero 10th byte overflows; continuation is unterminated', () => {
  // 10th byte terminating with digit 0 is the only legal 10-byte form here.
  const legal = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00];
  assert.equal(decode(legal).error, undefined);
  assert.equal(decode(legal).value, 0);

  const badDigit = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01];
  assert.equal(decode(badDigit).error, 'overflow');

  const continued = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80];
  assert.equal(decode(continued).error, 'unterminated');

  const eleven = [...continued, 0x00];
  assert.equal(decode(eleven).error, 'unterminated');
});

test('VarintReader: reports incomplete until terminator arrives', () => {
  const reader = new VarintReader();
  reader.push(0x80);
  assert.equal(reader.state.complete, false);
  reader.push(0x80);
  assert.equal(reader.state.complete, false);
  reader.push(0x01);
  const state = reader.state;
  assert.equal(state.complete, true);
  assert.equal(state.value, 16384);
});

test('encodeVarint: rejects negatives, non-integers and unsafe values', () => {
  assert.throws(() => encodeVarint(-1), RangeError);
  assert.throws(() => encodeVarint(1.5), RangeError);
  assert.throws(() => encodeVarint(Number.MAX_SAFE_INTEGER + 1), RangeError);
});
