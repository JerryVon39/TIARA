#!/usr/bin/env node
/**
 * 生成网页面板用的图标（favicon / apple-touch-icon）
 *
 *   node tools/make_icon.mjs                 # 从 shell/master/surface0.png 裁脸，出 64 与 180
 *   node tools/make_icon.mjs --from x.png --face 96,92,192,96
 *
 * 为什么自己做：项目零依赖，不想为了一个 64x64 的图标装 sharp。
 * PNG 读写只用 node:zlib，够用（只支持 8 位、非隔行的 RGB/RGBA）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const a = { from: 'shell/master/surface0.png', face: null, out: 'panel', sizes: [64, 180] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--face') a.face = argv[++i].split(',').map(Number);
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--sizes') a.sizes = argv[++i].split(',').map(Number);
  }
  return a;
}

/** PNG → { w, h, data: Uint8Array(RGBA) } */
export function decodePng(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('不是 PNG');
  let o = 8;
  let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.slice(o + 4, o + 8).toString('ascii');
    const body = buf.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      color = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (depth !== 8) throw new Error('只支持 8 位深，当前 ' + depth);
  if (interlace) throw new Error('不支持隔行 PNG');
  const ch = color === 6 ? 4 : color === 2 ? 3 : 0;
  if (!ch) throw new Error('只支持 RGB/RGBA，当前 colorType=' + color);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = Uint8Array.from(raw.slice(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      line[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const s = x * ch, d = (y * w + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { w, h, data: out };
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, body])));
  return Buffer.concat([len, t, body, crc]);
}

/** RGBA → PNG（每行 filter 0，够小） */
export function encodePng(w, h, data) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 区域平均缩放（box filter），保留 alpha 权重，透明边缘不会发黑 */
export function resize(img, sx, sy, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const y0 = sy + Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, sy + Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = sx + Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, sx + Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sy + sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sx + sw; xx++) {
          const i = (yy * img.w + xx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al;
          a += img.data[i + 3]; n++;
        }
      }
      const d = (y * dw + x) * 4;
      const aw = a / 255 || 1;
      out[d] = Math.round(r / aw);
      out[d + 1] = Math.round(g / aw);
      out[d + 2] = Math.round(b / aw);
      out[d + 3] = Math.round(a / n);
    }
  }
  return out;
}

/** 圆角遮罩 + 底色，让图标在深色/浅色标签页上都立得住 */
export function roundCorners(dw, dh, data, bg = [14, 17, 22], radius = 0.22) {
  const rr = Math.min(dw, dh) * radius;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const dx = Math.max(rr - x, 0, x - (dw - 1 - rr));
      const dy = Math.max(rr - y, 0, y - (dh - 1 - rr));
      const d = (y * dw + x) * 4;
      const inside = Math.hypot(dx, dy) <= rr;
      const al = data[d + 3] / 255;
      if (!inside) { data[d + 3] = 0; continue; }
      // 底色垫在下面（外圈），人像叠在上面
      data[d] = Math.round(data[d] * al + bg[0] * (1 - al));
      data[d + 1] = Math.round(data[d + 1] * al + bg[1] * (1 - al));
      data[d + 2] = Math.round(data[d + 2] * al + bg[2] * (1 - al));
      data[d + 3] = 255;
    }
  }
  return data;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  const src = path.resolve(ROOT, a.from);
  const img = decodePng(fs.readFileSync(src));
  const face = a.face || [96, 92, 192, 96]; // faces.json 的 face 区域，画布 384x576
  let sx, sy, sw, sh;
  if (a.face) {
    const pad = Math.round(face[3] * 0.35);
    sx = face[0]; sy = face[1] - pad; sw = face[2]; sh = face[3] + pad * 2;
  } else {
    // 方形裁切：从发顶往下取，头发/眼睛/领结都在框里（纯脸框会切掉头顶）
    const side = 252;
    const headTop = Math.max(0, face[1] - 84); // face 区域往上够到发顶
    sx = Math.round(face[0] + face[2] / 2 - side / 2);
    sy = headTop;
    sw = sh = side;
  }
  if (sx < 0) sx = 0;
  if (sy < 0) sy = 0;
  if (sx + sw > img.w) sw = img.w - sx;
  if (sy + sh > img.h) sh = img.h - sy;

  const outDir = path.resolve(ROOT, a.out);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const size of a.sizes) {
    const px = resize(img, sx, sy, sw, sh, size, size);
    roundCorners(size, size, px);
    const file = path.join(outDir, size === 180 ? 'icon-180.png' : `icon-${size}.png`);
    fs.writeFileSync(file, encodePng(size, size, px));
    written.push(path.relative(ROOT, file) + ' (' + size + 'x' + size + ')');
  }
  console.log('[make_icon] 源 ' + path.relative(ROOT, src) + ' 头像区 ' + face.join(','));
  for (const w of written) console.log('  → ' + w);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
