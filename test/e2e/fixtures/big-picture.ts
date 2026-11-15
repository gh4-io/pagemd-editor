// A large picture made at test time (P13b, amendment 11): a grey-scale PNG, `width` x `height`, with a diagonal gradient, so no
// 100 MB file is kept in git and the picture is the same every run. The file is small (the gradient compresses well) and decodes to
// width x height x 4 bytes in the browser, which is what the downscaled copy is meant to avoid keeping around.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Uint8Array): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** Writes the picture to `file` (folders made) and returns its size in bytes. */
export function writeBigPng(file: string, width: number, height: number): number {
  const row = width + 1; // a filter byte (0: none), then one grey byte per pixel
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    const at = y * row;
    for (let x = 0; x < width; x++) raw[at + 1 + x] = ((x >> 4) + (y >> 4)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grey scale
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 3 })), chunk('IEND', new Uint8Array())]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, png);
  return png.length;
}
