export { Crc32, crc32 } from './crc32.js';
export {
  DEFAULT_MAGIC,
  DEFAULT_MAX_PAYLOAD,
  CRC_SIZE,
  FrameEncoder,
  encodeFrame,
  type EncodeOptions,
} from './encoder.js';
export {
  FrameDecoder,
  type DecoderHandlers,
  type DecoderOptions,
  type DecodedFrame,
  type EndResult,
  type FrameError,
  type FrameErrorCode,
} from './decoder.js';
export {
  VarintReader,
  encodeVarint,
  MAX_VARINT_BYTES,
  type VarintError,
  type VarintResult,
} from './varint.js';
