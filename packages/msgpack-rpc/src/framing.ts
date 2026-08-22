type LengthHeaderKind = "payload" | "extension" | "array" | "map";

export type MessagePackFrameListener = (frame: Uint8Array) => void;

interface PendingChunk {
  readonly bytes: Uint8Array;
  readonly onFrame: MessagePackFrameListener;
}

/**
 * Synchronously separates a MessagePack byte stream into complete values.
 *
 * Parsing state survives transport chunk boundaries, so marker, header, and
 * payload bytes are never rescanned. Partial frames retain zero-copy views of
 * their transport chunks. If a frame spans chunks, completion allocates one
 * exact-size buffer and copies every byte once; a frame contained in one chunk
 * is emitted as a view of that chunk. Reentrant pushes are queued until the
 * active chunk is fully consumed, preserving byte-stream delivery order.
 */
export class MessagePackStreamFramer {
  #remainingValues = 1;
  #headerKind: LengthHeaderKind | null = null;
  #headerBytesRemaining = 0;
  #headerValue = 0;
  #payloadBytesRemaining = 0;
  #frameLength = 0;
  #segments: Uint8Array[] = [];
  #scannedByteCount = 0;
  #copiedByteCount = 0;
  #pendingChunks: PendingChunk[] = [];
  #pendingChunkIndex = 0;
  #draining = false;
  #resetGeneration = 0;

  get hasIncompleteFrame(): boolean {
    return this.#frameLength > 0;
  }

  get queuedSegmentCount(): number {
    return this.#segments.length;
  }

  get scannedByteCount(): number {
    return this.#scannedByteCount;
  }

  get copiedByteCount(): number {
    return this.#copiedByteCount;
  }

  push(chunk: Uint8Array, onFrame: MessagePackFrameListener): void {
    if (chunk.byteLength === 0) {
      return;
    }

    if (this.#draining) {
      this.#pendingChunks.push({ bytes: chunk, onFrame });
      return;
    }

    this.#draining = true;
    try {
      this.#consumeChunk(chunk, onFrame);
      while (this.#pendingChunkIndex < this.#pendingChunks.length) {
        const pending = this.#pendingChunks[this.#pendingChunkIndex]!;
        this.#pendingChunkIndex += 1;
        this.#consumeChunk(pending.bytes, pending.onFrame);
      }
    } finally {
      this.#pendingChunks.length = 0;
      this.#pendingChunkIndex = 0;
      this.#draining = false;
    }
  }

  #consumeChunk(chunk: Uint8Array, onFrame: MessagePackFrameListener): void {
    const resetGeneration = this.#resetGeneration;
    let cursor = 0;
    let framePartStart = 0;
    while (cursor < chunk.byteLength) {
      if (this.#payloadBytesRemaining > 0) {
        const consumed = Math.min(
          this.#payloadBytesRemaining,
          chunk.byteLength - cursor,
        );
        cursor += consumed;
        this.#payloadBytesRemaining -= consumed;
        this.#countScanned(consumed);
      } else if (this.#headerBytesRemaining > 0) {
        while (
          cursor < chunk.byteLength &&
          this.#headerBytesRemaining > 0
        ) {
          this.#headerValue = this.#headerValue * 256 + chunk[cursor]!;
          cursor += 1;
          this.#headerBytesRemaining -= 1;
          this.#countScanned(1);
        }
        if (this.#headerBytesRemaining === 0) {
          this.#finishLengthHeader();
        }
      } else {
        const marker = chunk[cursor]!;
        cursor += 1;
        this.#countScanned(1);
        this.#remainingValues -= 1;
        this.#readMarker(marker);
      }

      if (this.#frameIsComplete()) {
        const currentPart = chunk.subarray(framePartStart, cursor);
        const frame = this.#completeFrame(currentPart);
        framePartStart = cursor;
        onFrame(frame);
        if (this.#resetGeneration !== resetGeneration) {
          return;
        }
      }
    }

    if (framePartStart < chunk.byteLength) {
      this.#segments.push(chunk.subarray(framePartStart));
    }
  }

  reset(): void {
    this.#resetGeneration += 1;
    this.#resetFrameState();
    this.#scannedByteCount = 0;
    this.#copiedByteCount = 0;
    this.#pendingChunks.length = 0;
    this.#pendingChunkIndex = 0;
  }

  #readMarker(marker: number): void {
    // Positive/negative fixint, nil, and booleans.
    if (
      marker <= 0x7f ||
      marker >= 0xe0 ||
      marker === 0xc0 ||
      marker === 0xc2 ||
      marker === 0xc3
    ) {
      return;
    }

    if (marker >= 0x80 && marker <= 0x8f) {
      this.#addRemainingValues((marker & 0x0f) * 2);
      return;
    }
    if (marker >= 0x90 && marker <= 0x9f) {
      this.#addRemainingValues(marker & 0x0f);
      return;
    }
    if (marker >= 0xa0 && marker <= 0xbf) {
      this.#payloadBytesRemaining = marker & 0x1f;
      return;
    }

    switch (marker) {
      case 0xc1:
        throw new Error("MessagePack marker 0xc1 is reserved");
      case 0xc4: // bin 8
      case 0xd9: // str 8
        this.#beginLengthHeader(1, "payload");
        return;
      case 0xc5: // bin 16
      case 0xda: // str 16
        this.#beginLengthHeader(2, "payload");
        return;
      case 0xc6: // bin 32
      case 0xdb: // str 32
        this.#beginLengthHeader(4, "payload");
        return;
      case 0xc7: // ext 8
        this.#beginLengthHeader(1, "extension");
        return;
      case 0xc8: // ext 16
        this.#beginLengthHeader(2, "extension");
        return;
      case 0xc9: // ext 32
        this.#beginLengthHeader(4, "extension");
        return;
      case 0xca: // float 32
        this.#payloadBytesRemaining = 4;
        return;
      case 0xcb: // float 64
        this.#payloadBytesRemaining = 8;
        return;
      case 0xcc: // uint 8
      case 0xd0: // int 8
        this.#payloadBytesRemaining = 1;
        return;
      case 0xcd: // uint 16
      case 0xd1: // int 16
        this.#payloadBytesRemaining = 2;
        return;
      case 0xce: // uint 32
      case 0xd2: // int 32
        this.#payloadBytesRemaining = 4;
        return;
      case 0xcf: // uint 64
      case 0xd3: // int 64
        this.#payloadBytesRemaining = 8;
        return;
      case 0xd4: // fixext 1: type byte + payload
        this.#payloadBytesRemaining = 2;
        return;
      case 0xd5: // fixext 2
        this.#payloadBytesRemaining = 3;
        return;
      case 0xd6: // fixext 4
        this.#payloadBytesRemaining = 5;
        return;
      case 0xd7: // fixext 8
        this.#payloadBytesRemaining = 9;
        return;
      case 0xd8: // fixext 16
        this.#payloadBytesRemaining = 17;
        return;
      case 0xdc: // array 16
        this.#beginLengthHeader(2, "array");
        return;
      case 0xdd: // array 32
        this.#beginLengthHeader(4, "array");
        return;
      case 0xde: // map 16
        this.#beginLengthHeader(2, "map");
        return;
      case 0xdf: // map 32
        this.#beginLengthHeader(4, "map");
        return;
      default:
        throw new Error(
          `Unsupported MessagePack marker 0x${marker.toString(16)}`,
        );
    }
  }

  #beginLengthHeader(width: 1 | 2 | 4, kind: LengthHeaderKind): void {
    this.#headerKind = kind;
    this.#headerBytesRemaining = width;
    this.#headerValue = 0;
  }

  #finishLengthHeader(): void {
    const kind = this.#headerKind;
    const length = this.#headerValue;
    this.#headerKind = null;
    this.#headerValue = 0;

    switch (kind) {
      case "payload":
        this.#payloadBytesRemaining = length;
        return;
      case "extension":
        this.#payloadBytesRemaining = length + 1;
        return;
      case "array":
        this.#addRemainingValues(length);
        return;
      case "map":
        this.#addRemainingValues(length * 2);
        return;
      default:
        throw new Error("MessagePack length header state is invalid");
    }
  }

  #addRemainingValues(count: number): void {
    const next = this.#remainingValues + count;
    if (!Number.isSafeInteger(next)) {
      throw new Error("MessagePack container is too large");
    }
    this.#remainingValues = next;
  }

  #countScanned(count: number): void {
    this.#frameLength += count;
    this.#scannedByteCount += count;
    if (!Number.isSafeInteger(this.#frameLength)) {
      throw new Error("MessagePack frame is too large");
    }
  }

  #frameIsComplete(): boolean {
    return (
      this.#remainingValues === 0 &&
      this.#headerBytesRemaining === 0 &&
      this.#payloadBytesRemaining === 0
    );
  }

  #completeFrame(currentPart: Uint8Array): Uint8Array {
    let frame: Uint8Array;
    if (this.#segments.length === 0) {
      frame = currentPart;
    } else {
      frame = new Uint8Array(this.#frameLength);
      let writeOffset = 0;
      for (const segment of this.#segments) {
        frame.set(segment, writeOffset);
        writeOffset += segment.byteLength;
      }
      frame.set(currentPart, writeOffset);
      this.#copiedByteCount += this.#frameLength;
    }
    this.#resetFrameState();
    return frame;
  }

  #resetFrameState(): void {
    this.#remainingValues = 1;
    this.#headerKind = null;
    this.#headerBytesRemaining = 0;
    this.#headerValue = 0;
    this.#payloadBytesRemaining = 0;
    this.#frameLength = 0;
    this.#segments = [];
  }
}
