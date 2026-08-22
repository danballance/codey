import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";

import { MessagePackStreamFramer } from "./framing.js";

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function frameChunks(chunks: readonly Uint8Array[]): {
  readonly framer: MessagePackStreamFramer;
  readonly frames: Uint8Array[];
} {
  const framer = new MessagePackStreamFramer();
  const frames: Uint8Array[] = [];
  for (const chunk of chunks) {
    framer.push(chunk, (frame) => frames.push(frame));
  }
  return { framer, frames };
}

describe("MessagePackStreamFramer", () => {
  it("finds representative RPC and redraw values at every two-chunk split", () => {
    const values = [
      [1, 73, null, { accepted: 4 }],
      [
        2,
        "redraw",
        [
          ["grid_line", [1, 0, 0, [["λ", 3], ["界"], [" ", 0, 4]]]],
          ["flush", []],
        ],
      ],
    ];

    for (const value of values) {
      const bytes = encode(value);
      for (let split = 0; split <= bytes.byteLength; split += 1) {
        const { framer, frames } = frameChunks([
          bytes.subarray(0, split),
          bytes.subarray(split),
        ]);
        expect(frames, `split ${split}/${bytes.byteLength}`).toHaveLength(1);
        expect(decode(frames[0]!)).toEqual(value);
        expect(framer.hasIncompleteFrame).toBe(false);
        expect(framer.scannedByteCount).toBe(bytes.byteLength);
      }
    }
  });

  it("covers every MessagePack marker family with one-byte fragmentation", () => {
    const frames = [
      Uint8Array.of(0x01),
      Uint8Array.of(0xe1),
      Uint8Array.of(0xc0),
      Uint8Array.of(0xc2),
      Uint8Array.of(0x81, 0xa1, 0x6b, 0x01),
      Uint8Array.of(0x91, 0x01),
      Uint8Array.of(0xa1, 0x61),
      Uint8Array.of(0xc4, 0x01, 0xff),
      Uint8Array.of(0xc5, 0x00, 0x01, 0xff),
      Uint8Array.of(0xc6, 0x00, 0x00, 0x00, 0x01, 0xff),
      Uint8Array.of(0xc7, 0x01, 0x02, 0xff),
      Uint8Array.of(0xc8, 0x00, 0x01, 0x02, 0xff),
      Uint8Array.of(0xc9, 0x00, 0x00, 0x00, 0x01, 0x02, 0xff),
      Uint8Array.of(0xca, 0x00, 0x00, 0x00, 0x00),
      Uint8Array.of(0xcb, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00),
      Uint8Array.of(0xcc, 0x01),
      Uint8Array.of(0xcd, 0x00, 0x01),
      Uint8Array.of(0xce, 0x00, 0x00, 0x00, 0x01),
      Uint8Array.of(0xcf, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01),
      Uint8Array.of(0xd0, 0xff),
      Uint8Array.of(0xd1, 0xff, 0xff),
      Uint8Array.of(0xd2, 0xff, 0xff, 0xff, 0xff),
      Uint8Array.of(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      Uint8Array.of(0xd4, 0x02, 0xff),
      Uint8Array.of(0xd5, 0x02, 0xff, 0xff),
      Uint8Array.of(0xd6, 0x02, 0xff, 0xff, 0xff, 0xff),
      Uint8Array.of(0xd7, 0x02, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff),
      Uint8Array.of(
        0xd8,
        0x02,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
      ),
      Uint8Array.of(0xd9, 0x01, 0x61),
      Uint8Array.of(0xda, 0x00, 0x01, 0x61),
      Uint8Array.of(0xdb, 0x00, 0x00, 0x00, 0x01, 0x61),
      Uint8Array.of(0xdc, 0x00, 0x01, 0x01),
      Uint8Array.of(0xdd, 0x00, 0x00, 0x00, 0x01, 0x01),
      Uint8Array.of(0xde, 0x00, 0x01, 0xa1, 0x6b, 0x01),
      Uint8Array.of(0xdf, 0x00, 0x00, 0x00, 0x01, 0xa1, 0x6b, 0x01),
    ];
    const stream = concatenate(...frames);
    const result = frameChunks([...stream].map((byte) => Uint8Array.of(byte)));

    expect(result.frames).toEqual(frames);
    expect(result.framer.hasIncompleteFrame).toBe(false);
    expect(result.framer.scannedByteCount).toBe(stream.byteLength);
    expect(result.framer.copiedByteCount).toBe(
      frames
        .filter((frame) => frame.byteLength > 1)
        .reduce((byteLength, frame) => byteLength + frame.byteLength, 0),
    );
  });

  it("emits zero-copy views for frames contained in one transport chunk", () => {
    const first = encode([2, "first", [1]]);
    const second = encode([2, "second", [2]]);
    const storage = new Uint8Array(first.byteLength + second.byteLength + 8);
    storage.set(first, 4);
    storage.set(second, 4 + first.byteLength);
    const chunk = storage.subarray(4, storage.byteLength - 4);
    const { framer, frames } = frameChunks([chunk]);

    expect(frames).toHaveLength(2);
    expect(frames[0]?.buffer).toBe(storage.buffer);
    expect(frames[1]?.buffer).toBe(storage.buffer);
    expect(framer.copiedByteCount).toBe(0);
  });

  it("allocates one exact buffer when a frame spans chunks", () => {
    const bytes = encode([2, "redraw", [["grid_line", [1, 0, 0, [["x", 2, 50]]]]]]);
    const split = Math.floor(bytes.byteLength / 2);
    const { framer, frames } = frameChunks([
      bytes.subarray(0, split),
      bytes.subarray(split),
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(bytes);
    expect(frames[0]?.byteOffset).toBe(0);
    expect(frames[0]?.buffer.byteLength).toBe(bytes.byteLength);
    expect(framer.copiedByteCount).toBe(bytes.byteLength);
  });

  it("emits complete frames and retains only a trailing partial frame", () => {
    const first = encode([2, "first", []]);
    const second = encode([2, "second", [1, 2, 3]]);
    const split = Math.floor(second.byteLength / 2);
    const framer = new MessagePackStreamFramer();
    const frames: Uint8Array[] = [];

    framer.push(concatenate(first, second.subarray(0, split)), (frame) =>
      frames.push(frame),
    );
    expect(frames.map((frame) => decode(frame))).toEqual([[2, "first", []]]);
    expect(framer.hasIncompleteFrame).toBe(true);
    expect(framer.queuedSegmentCount).toBe(1);

    framer.push(second.subarray(split), (frame) => frames.push(frame));
    expect(frames.map((frame) => decode(frame))).toEqual([
      [2, "first", []],
      [2, "second", [1, 2, 3]],
    ]);
    expect(framer.hasIncompleteFrame).toBe(false);
    expect(framer.queuedSegmentCount).toBe(0);
  });

  it("preserves order under deterministic random fragmentation", () => {
    const values = Array.from({ length: 80 }, (_, index) => [
      2,
      `event-${index}`,
      [{ index, binary: Uint8Array.of(index, 255 - index) }],
    ]);
    const stream = concatenate(...values.map((value) => encode(value)));
    const chunks: Uint8Array[] = [];
    let seed = 0x5eed_1234;
    let offset = 0;
    while (offset < stream.byteLength) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const length = 1 + (seed % 97);
      chunks.push(stream.subarray(offset, Math.min(offset + length, stream.byteLength)));
      offset += length;
    }

    const { framer, frames } = frameChunks(chunks);
    expect(frames.map((frame) => decode(frame))).toEqual(values);
    expect(framer.scannedByteCount).toBe(stream.byteLength);
    expect(framer.hasIncompleteFrame).toBe(false);
  });

  it("queues reentrant pushes behind the unscanned remainder of the current chunk", () => {
    const framer = new MessagePackStreamFramer();
    const first = encode("outer-first");
    const second = encode("outer-second");
    const nested = encode("nested");
    const delivered: unknown[] = [];
    const onFrame = (frame: Uint8Array): void => {
      const value = decode(frame);
      delivered.push(value);
      if (value === "outer-first") {
        framer.push(nested, onFrame);
      }
    };

    framer.push(concatenate(first, second), onFrame);

    expect(delivered).toEqual(["outer-first", "outer-second", "nested"]);
    expect(framer.scannedByteCount).toBe(
      first.byteLength + second.byteLength + nested.byteLength,
    );
    expect(framer.hasIncompleteFrame).toBe(false);
  });

  it("stops the active chunk when a frame callback resets the framer", () => {
    const framer = new MessagePackStreamFramer();
    const delivered: unknown[] = [];
    const first = encode("close-now");
    const skipped = encode("must-not-deliver");

    framer.push(concatenate(first, skipped), (frame) => {
      delivered.push(decode(frame));
      framer.reset();
    });

    expect(delivered).toEqual(["close-now"]);
    expect(framer.scannedByteCount).toBe(0);
    expect(framer.hasIncompleteFrame).toBe(false);

    framer.push(encode("new-lifecycle"), (frame) => delivered.push(decode(frame)));
    expect(delivered).toEqual(["close-now", "new-lifecycle"]);
    expect(framer.hasIncompleteFrame).toBe(false);
  });

  it("scans and copies a 58 KiB fragmented frame no more than once", () => {
    const bytes = encode([2, "redraw", [new Uint8Array(58 * 1_024)]]);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 512) {
      chunks.push(bytes.subarray(offset, Math.min(offset + 512, bytes.byteLength)));
    }

    const { framer, frames } = frameChunks(chunks);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(bytes);
    expect(framer.scannedByteCount).toBe(bytes.byteLength);
    expect(framer.copiedByteCount).toBe(bytes.byteLength);
  });

  it("delivers preceding frames before rejecting a reserved marker", () => {
    const valid = encode([2, "redraw", []]);
    const framer = new MessagePackStreamFramer();
    const frames: Uint8Array[] = [];

    expect(() => {
      framer.push(concatenate(valid, Uint8Array.of(0xc1)), (frame) =>
        frames.push(frame),
      );
    }).toThrow("reserved");
    expect(frames).toEqual([valid]);
  });

  it("clears incomplete data and counters on reset", () => {
    const framer = new MessagePackStreamFramer();
    framer.push(Uint8Array.of(0xdb, 0x00), () => undefined);
    expect(framer.hasIncompleteFrame).toBe(true);

    framer.reset();

    expect(framer.hasIncompleteFrame).toBe(false);
    expect(framer.queuedSegmentCount).toBe(0);
    expect(framer.scannedByteCount).toBe(0);
    expect(framer.copiedByteCount).toBe(0);
  });
});
