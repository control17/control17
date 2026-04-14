#!/usr/bin/env node
/**
 * Solid-color PNG icon generator for the control17 web app.
 *
 * Writes `public/icons/icon-192.png` and `public/icons/icon-512.png`
 * as solid fill with the C17 primary color (#5f875f). Encodes PNG
 * from scratch using `node:zlib` + a hand-rolled CRC32 — no `sharp`
 * or native deps required, so `pnpm install` in CI doesn't need a
 * prebuild cache or build toolchain.
 *
 * Run once at setup, commit the resulting PNGs, forget about it:
 *
 *   node packages/web/scripts/generate-icons.mjs
 *
 * If you change the brand color or want to ship a real logo, replace
 * the solid-fill loop with your own pixel source; the PNG-assembly
 * helpers below are generic.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const BRAND_R = 0x5f;
const BRAND_G = 0x87;
const BRAND_B = 0x5f;

// CRC32 lookup table (standard PNG-required polynomial 0xedb88320).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  // [length(4)] [type(4)] [data] [crc(4)]
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcSrc = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcSrc), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Build a solid-color RGBA PNG at the given size. The pixel loop
 * writes filtered scanlines (filter byte 0 = None) because it's the
 * simplest filter and compresses well enough for a uniform fill.
 */
function makeSolidPng(size, r, g, b) {
  const width = size;
  const height = size;
  const rowLen = 1 + width * 4; // filter byte + RGBA
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 9 });

  // IHDR: width(4) height(4) bit-depth(1=8) color-type(1=6 RGBA) compression(1=0) filter(1=0) interlace(1=0)
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

for (const size of [192, 512]) {
  const png = makeSolidPng(size, BRAND_R, BRAND_G, BRAND_B);
  const out = join(outDir, `icon-${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${size}x${size}, ${png.length} bytes)`);
}
