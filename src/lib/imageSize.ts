export type ImageSize = { width: number; height: number };

function isAscii(buf: Buffer, offset: number, value: string): boolean {
  if (offset + value.length > buf.length) return false;
  for (let i = 0; i < value.length; i += 1) {
    if (buf[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function readUInt24LE(buf: Buffer, offset: number): number | null {
  if (offset + 3 > buf.length) return null;
  return buf[offset] + (buf[offset + 1] << 8) + (buf[offset + 2] << 16);
}

function parsePng(buf: Buffer): ImageSize | null {
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    return null;
  }
  // IHDR starts at offset 12, width/height at 16/20.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function isJpegSofMarker(marker: number): boolean {
  // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpeg(buf: Buffer): ImageSize | null {
  if (buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI

  let offset = 2;
  while (offset + 4 <= buf.length) {
    // Find next marker.
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    if (offset >= buf.length) break;
    const marker = buf[offset];
    offset += 1;

    // Standalone markers without a length.
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM / RSTn

    if (offset + 2 > buf.length) break;
    const segmentLength = buf.readUInt16BE(offset);
    if (segmentLength < 2) return null;

    if (isJpegSofMarker(marker)) {
      // Segment: length (2) + precision (1) + height (2) + width (2) ...
      if (offset + 7 > buf.length) return null;
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }
  return null;
}

function parseWebp(buf: Buffer): ImageSize | null {
  // RIFF....WEBP
  if (buf.length < 16) return null;
  if (!isAscii(buf, 0, 'RIFF') || !isAscii(buf, 8, 'WEBP')) return null;

  // First chunk type at 12
  const chunkType = buf.toString('ascii', 12, 16);
  const chunkSize = buf.readUInt32LE(16);
  const dataOffset = 20;

  if (chunkType === 'VP8X') {
    // width/height are stored as 24-bit little endian (minus 1).
    const wMinus1 = readUInt24LE(buf, dataOffset + 4);
    const hMinus1 = readUInt24LE(buf, dataOffset + 7);
    if (wMinus1 == null || hMinus1 == null) return null;
    return { width: wMinus1 + 1, height: hMinus1 + 1 };
  }

  if (chunkType === 'VP8L') {
    // Lossless WebP
    if (dataOffset + 5 > buf.length) return null;
    if (buf[dataOffset] !== 0x2f) return null; // signature
    const b0 = buf[dataOffset + 1];
    const b1 = buf[dataOffset + 2];
    const b2 = buf[dataOffset + 3];
    const b3 = buf[dataOffset + 4];
    const width = 1 + (b0 | ((b1 & 0x3f) << 8));
    const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }

  if (chunkType === 'VP8 ') {
    // Lossy WebP - parse frame header.
    // Chunk payload begins with:
    // - 3 bytes frame tag
    // - 3 bytes start code 0x9D 0x01 0x2A
    // - 2 bytes width (14 bits)
    // - 2 bytes height (14 bits)
    const headerOffset = dataOffset;
    if (headerOffset + 10 > buf.length) return null;
    if (buf[headerOffset + 3] !== 0x9d || buf[headerOffset + 4] !== 0x01 || buf[headerOffset + 5] !== 0x2a) return null;
    const widthRaw = buf.readUInt16LE(headerOffset + 6);
    const heightRaw = buf.readUInt16LE(headerOffset + 8);
    const width = widthRaw & 0x3fff;
    const height = heightRaw & 0x3fff;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }

  // Some WebP files include extra chunks; we could scan, but keep it simple for now.
  // If the first chunk isn't a known bitmap chunk, try to skip it and find VP8X/VP8L/VP8.
  const nextOffset = dataOffset + chunkSize + (chunkSize % 2);
  if (nextOffset + 8 > buf.length) return null;
  const nextType = buf.toString('ascii', nextOffset, nextOffset + 4);
  const nextSize = buf.readUInt32LE(nextOffset + 4);
  const nextData = nextOffset + 8;

  if (nextType === 'VP8X') {
    const wMinus1 = readUInt24LE(buf, nextData + 4);
    const hMinus1 = readUInt24LE(buf, nextData + 7);
    if (wMinus1 == null || hMinus1 == null) return null;
    return { width: wMinus1 + 1, height: hMinus1 + 1 };
  }
  if (nextType === 'VP8L') {
    if (nextData + 5 > buf.length) return null;
    if (buf[nextData] !== 0x2f) return null;
    const b0 = buf[nextData + 1];
    const b1 = buf[nextData + 2];
    const b2 = buf[nextData + 3];
    const b3 = buf[nextData + 4];
    const width = 1 + (b0 | ((b1 & 0x3f) << 8));
    const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }
  if (nextType === 'VP8 ') {
    if (nextData + 10 > buf.length) return null;
    if (buf[nextData + 3] !== 0x9d || buf[nextData + 4] !== 0x01 || buf[nextData + 5] !== 0x2a) return null;
    const widthRaw = buf.readUInt16LE(nextData + 6);
    const heightRaw = buf.readUInt16LE(nextData + 8);
    const width = widthRaw & 0x3fff;
    const height = heightRaw & 0x3fff;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  }

  void nextSize; // keep for potential future chunk scanning
  return null;
}

export function getImageSizeFromBytes(bytes: Buffer, mimeType: string): ImageSize | null {
  const type = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (type === 'image/png') return parsePng(bytes);
  if (type === 'image/jpeg' || type === 'image/jpg') return parseJpeg(bytes);
  if (type === 'image/webp') return parseWebp(bytes);
  return null;
}

