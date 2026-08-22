/**
 * Finds the end of one MessagePack value without decoding it. Returning null
 * means that another byte chunk is needed. TCP has no relationship to RPC
 * message boundaries, so this small scanner is deliberately independent of
 * the chunks supplied by a transport.
 */
export function findMessagePackValueEnd(
  bytes: Uint8Array,
  start = 0,
): number | null {
  let cursor = start;
  let remainingValues = 1;

  const requireBytes = (count: number): boolean =>
    count <= bytes.byteLength - cursor;

  const readLength = (width: 1 | 2 | 4): number | null => {
    if (!requireBytes(width)) {
      return null;
    }

    let value = 0;
    for (let index = 0; index < width; index++) {
      value = value * 256 + bytes[cursor + index]!;
    }
    cursor += width;
    return value;
  };

  const skipPayload = (length: number): boolean => {
    if (!requireBytes(length)) {
      return false;
    }
    cursor += length;
    return true;
  };

  while (remainingValues > 0) {
    if (!requireBytes(1)) {
      return null;
    }

    const marker = bytes[cursor++]!;
    remainingValues--;

    // Positive/negative fixint, nil, booleans.
    if (
      marker <= 0x7f ||
      marker >= 0xe0 ||
      marker === 0xc0 ||
      marker === 0xc2 ||
      marker === 0xc3
    ) {
      continue;
    }

    // fixmap
    if (marker >= 0x80 && marker <= 0x8f) {
      remainingValues += (marker & 0x0f) * 2;
      continue;
    }

    // fixarray
    if (marker >= 0x90 && marker <= 0x9f) {
      remainingValues += marker & 0x0f;
      continue;
    }

    // fixstr
    if (marker >= 0xa0 && marker <= 0xbf) {
      if (!skipPayload(marker & 0x1f)) {
        return null;
      }
      continue;
    }

    let length: number | null;
    switch (marker) {
      case 0xc1:
        throw new Error("MessagePack marker 0xc1 is reserved");
      case 0xc4: // bin 8
      case 0xd9: // str 8
        length = readLength(1);
        if (length === null || !skipPayload(length)) return null;
        break;
      case 0xc5: // bin 16
      case 0xda: // str 16
        length = readLength(2);
        if (length === null || !skipPayload(length)) return null;
        break;
      case 0xc6: // bin 32
      case 0xdb: // str 32
        length = readLength(4);
        if (length === null || !skipPayload(length)) return null;
        break;
      case 0xc7: // ext 8
        length = readLength(1);
        if (length === null || !skipPayload(length + 1)) return null;
        break;
      case 0xc8: // ext 16
        length = readLength(2);
        if (length === null || !skipPayload(length + 1)) return null;
        break;
      case 0xc9: // ext 32
        length = readLength(4);
        if (length === null || !skipPayload(length + 1)) return null;
        break;
      case 0xca: // float 32
        if (!skipPayload(4)) return null;
        break;
      case 0xcb: // float 64
        if (!skipPayload(8)) return null;
        break;
      case 0xcc: // uint 8
      case 0xd0: // int 8
        if (!skipPayload(1)) return null;
        break;
      case 0xcd: // uint 16
      case 0xd1: // int 16
        if (!skipPayload(2)) return null;
        break;
      case 0xce: // uint 32
      case 0xd2: // int 32
        if (!skipPayload(4)) return null;
        break;
      case 0xcf: // uint 64
      case 0xd3: // int 64
        if (!skipPayload(8)) return null;
        break;
      case 0xd4: // fixext 1: type byte + payload
        if (!skipPayload(2)) return null;
        break;
      case 0xd5: // fixext 2
        if (!skipPayload(3)) return null;
        break;
      case 0xd6: // fixext 4
        if (!skipPayload(5)) return null;
        break;
      case 0xd7: // fixext 8
        if (!skipPayload(9)) return null;
        break;
      case 0xd8: // fixext 16
        if (!skipPayload(17)) return null;
        break;
      case 0xdc: // array 16
        length = readLength(2);
        if (length === null) return null;
        remainingValues += length;
        break;
      case 0xdd: // array 32
        length = readLength(4);
        if (length === null) return null;
        remainingValues += length;
        break;
      case 0xde: // map 16
        length = readLength(2);
        if (length === null) return null;
        remainingValues += length * 2;
        break;
      case 0xdf: // map 32
        length = readLength(4);
        if (length === null) return null;
        remainingValues += length * 2;
        break;
      default:
        throw new Error(`Unsupported MessagePack marker 0x${marker.toString(16)}`);
    }
  }

  return cursor;
}
