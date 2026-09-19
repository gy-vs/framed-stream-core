# framed-stream-core

零依赖的二进制分帧库。固定帧格式：

```
+----------+-------------------+-------------+------------+
|  magic   |  length (varint)  |   payload   |  CRC32     |
| 4 bytes  |  LEB128 unsigned  |  N bytes    |  4 bytes   |
+----------+-------------------+-------------+------------+
  9D 6D 33 C1                     big-endian, = CRC32(payload)
```

- **magic**：同步标记，默认 `9D 6D 33 C1`，可配置（任意非空字节序列）。
- **length**：无符号 base-128 LEB128 varint（同 protobuf `uint64` 的线格式），最多 10 字节；可表示范围上限为 `Number.MAX_SAFE_INTEGER`。
- **payload**：任意字节，允许为空。
- **CRC32**：仅对 payload 计算，IEEE 802.3（多项式反射形式 `0xEDB88320`，与 zlib/gzip/PNG 一致），big-endian 写入。

不做文件、网络或命令行适配——只负责编码与增量解码。

## 安装与测试

```bash
npm install
npm test          # node:test + tsx，无需构建
npm run typecheck
npm run build     # 输出 ESM + .d.ts 到 dist/
```

要求 Node.js >= 20，TypeScript 5，无运行时依赖。

## 编码

```ts
import { encodeFrame } from 'framed-stream-core';

const frame: Uint8Array = encodeFrame(new TextEncoder().encode('hello'));
// 可传 { magic } 自定义同步标记；返回值大小精确且与入参不共享内存
```

## 增量解码

`push()` 接受任意大小的 `Uint8Array` 数据块，帧与错误都在调用期间通过回调同步、按流顺序产出：

```ts
import { FrameDecoder } from 'framed-stream-core';

const decoder = new FrameDecoder({
  onFrame: (payload: Uint8Array) => {
    // payload 是独立拷贝，回调返回后仍有效
  },
  onError: (error) => {
    console.error(error.code, error.message);
    // 出错不会中断解码，见下文恢复规则
  },
}, {
  // magic: customMagic,
  maxPayloadLength: 16 * 1024 * 1024, // 默认 16 MiB
});

socket.on('data', (chunk: Uint8Array) => decoder.push(chunk));
socket.on('end', () => {
  const result = decoder.finish();
  if (!result.ok) {
    result.error.code; // 'ERR_PARTIAL_FRAME' | 'ERR_TRAILING_BYTES'
  }
});
```

`finish()` 区分三种结束状态：

| 结果 | 含义 |
| --- | --- |
| `{ ok: true }` | 干净结束，无残留字节 |
| `{ ok: false, code: 'ERR_PARTIAL_FRAME' }` | 残留以 magic 开头的半帧（长度半截、payload 或 CRC 没收全） |
| `{ ok: false, code: 'ERR_TRAILING_BYTES' }` | 残留不以 magic 开头的杂散字节 |

`finish()` 后解码器自动 reset，可复用于新流；也可随时手动 `reset()`。

## 错误与恢复

流内候选帧被拒绝时（不会抛出，走 `onError`）：

| code | 触发条件 |
| --- | --- |
| `ERR_VARINT_OVERFLOW` | 长度 varint 超过 10 字节、第 10 字节仍带延续位，或值超过 `Number.MAX_SAFE_INTEGER` |
| `ERR_LENGTH_EXCEEDED` | 声明长度超过 `maxPayloadLength`（立即报错，不等待巨型 payload 到齐） |
| `ERR_CRC_MISMATCH` | 帧完整到齐但校验和不匹配 |

恢复规则：任何候选被拒后，解码器从**该候选 magic 的下一个字节**开始重新扫描后续字节中的 magic。因此损坏 payload 内部恰好出现的"伪 magic"不会被误产出——只有从该位置起的长度合法、帧完整且 CRC 校验全部成立时，才会作为恢复帧交付。若损坏把长度 varint 改大，解码器会等待声明的字节数到齐后让 CRC 失败，再逐字节重扫恢复。

## 内存保证

所有未消费字节只存放在一块可增长缓冲区中（`[pos, end)` 窗口）：

- 已确认无用的前缀在确认当下即通过 `copyWithin` 搬移/缩容释放，从不拼接全部历史字节；
- 拒绝候选时按候选粒度滑窗释放损坏数据，长损坏流不会累积；
- 完整排空大缓冲（>64 KiB）后立即收缩回小分配。

可用 `decoder.bufferedBytes`（待处理字节数）与 `decoder.bufferCapacity`（诊断用容量）观察。

## 导出

`encodeFrame` / `FrameDecoder` / `FrameError`，以及底层件 `crc32`、`Crc32`、`encodeVarint`、`readVarint`、`varintLength`、`writeVarint`、常量 `DEFAULT_MAGIC`、`DEFAULT_MAX_PAYLOAD_LENGTH`、`MAX_VARINT_BYTES`。
