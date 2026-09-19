import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRC_SIZE,
  DEFAULT_MAGIC,
  FrameEncoder,
  encodeFrame,
} from '../src/encoder.js';
import { crc32 } from '../src/crc32.js';
import { encodeVarint } from '../src/varint.js';

test('encodeFrame: empty payload layout', () => {
  const frame = encodeFrame(new Uint8Array());
  const expectedLength = DEFAULT_MAGIC.length + 1 + CRC_SIZE;
  assert.equal(frame.length, expectedLength);
  assert.deepEqual(frame.subarray(0, DEFAULT_MAGIC.length), DEFAULT_MAGIC);
  assert.equal(frame[DEFAULT_MAGIC.length], 0x00);
  const crc = frame.subarray(frame.length - CRC_SIZE);
  assert.deepEqual([...crc], [0x00, 0x00, 0x00, 0x00]);
});

test('encodeFrame: magic | varint length | payload | big-endian CRC32', () => {
  const payload = new TextEncoder().encode('hello frame');
  const frame = encodeFrame(payload);
  const lenBytes = encodeVarint(payload.length);

  let offset = 0;
  assert.deepEqual(frame.subarray(offset, offset + DEFAULT_MAGIC.length), DEFAULT_MAGIC);
  offset += DEFAULT_MAGIC.length;
  assert.deepEqual(frame.subarray(offset, offset + lenBytes.length), lenBytes);
  offset += lenBytes.length;
  assert.deepEqual(frame.subarray(offset, offset + payload.length), payload);
  offset += payload.length;
  const crc = crc32(payload);
  assert.deepEqual(
    [...frame.subarray(offset, offset + 4)],
    [(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff],
  );
});

test('encodeFrame: returns a fresh buffer that does not alias the payload', () => {
  const payload = new Uint8Array([1, 2, 3]);
  const frame = encodeFrame(payload);
  payload[0] = 99;
  const lenStart = DEFAULT_MAGIC.length + 1;
  assert.equal(frame[lenStart], 1);
});

test('FrameEncoder: carries a fixed (possibly custom) magic', () => {
  const payload = Uint8Array.of(0xaa, 0xbb);
  const encoder = new FrameEncoder({ magic: Uint8Array.of(0xde, 0xad) });
  const frame = encoder.encode(payload);
  assert.equal(frame[0], 0xde);
  assert.equal(frame[1], 0xad);
  assert.equal(frame[2], 2);
});

test('FrameEncoder: rejects empty magic', () => {
  assert.throws(() => new FrameEncoder({ magic: new Uint8Array() }), RangeError);
});
