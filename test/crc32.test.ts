import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Crc32, crc32 } from '../src/crc32.js';

// Reference implementation independent of the table-driven module code.
function referenceCrc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('crc32: empty input is the xorout value', () => {
  assert.equal(crc32(new Uint8Array()), 0x00000000);
  assert.equal(new Crc32().finish(), 0x00000000);
});

test('crc32: known check vector for "123456789"', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('crc32: streaming updates match the one-shot function across arbitrary splits', () => {
  const data = new Uint8Array(2000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;

  const expected = referenceCrc(data);
  assert.equal(crc32(data), expected);

  // Split at every possible boundary 0..length.
  for (let split = 0; split <= data.length; split += 97) {
    const acc = new Crc32();
    acc.update(data, 0, split);
    acc.update(data, split);
    assert.equal(acc.finish(), expected);
  }
});

test('crc32: byte-by-byte streaming agrees', () => {
  const data = Uint8Array.from([0x9d, 0x4a, 0x3f, 0x21, 0x00, 0xff, 0x80, 0x7f]);
  const acc = new Crc32();
  for (const b of data) acc.update(Uint8Array.of(b));
  assert.equal(acc.finish(), crc32(data));
});
