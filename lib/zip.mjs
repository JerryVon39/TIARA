/**
 * 零依赖的 store-only ZIP 写入器（不压缩，够用：SSP 人格包、便携包）。
 *
 * 从 tools/pack_ssp.mjs 抽出来的，好让 pack_portable.mjs 复用、也方便单测
 * （zip 结构写错的表现是「解压软件能打开但文件损坏」，不测很难发现）。
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS 时间戳（zip 里只有这个格式；年份从 1980 起，早于它的一律夹到 1980） */
export function dosTime(d) {
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | (((d.getSeconds() / 2) | 0) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * @param {{name:string,data:Buffer}[]} files  name 用 / 分隔，可带中文
 * @param {Date} [when]  文件时间，默认现在
 * @returns {Buffer} 完整 zip
 */
export function buildZip(files, when = new Date()) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, date } = dosTime(when);

  for (const f of files) {
    const nameBuf = Buffer.from(f.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      // version needed
    local.writeUInt16LE(0x0800, 6);  // UTF-8 名字
    local.writeUInt16LE(0, 8);       // store（不压缩）
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    locals.push(local, nameBuf, f.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);    // version made by
    central.writeUInt16LE(20, 6);    // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);     // extra
    central.writeUInt16LE(0, 32);     // comment
    central.writeUInt16LE(0, 34);     // disk
    central.writeUInt16LE(0, 36);     // internal attr
    central.writeUInt32LE(0, 38);     // external attr
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * 极简读取（只认 store-only、无 zip64），用来在单测/自检里校验刚写出来的包。
 * @returns {{name:string,data:Buffer}[]}
 */
export function readZip(buf) {
  const out = [];
  let i = 0;
  while (i + 30 <= buf.length && buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString('utf8');
    const start = i + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('只支持 store（未压缩），实际 method=' + method);
    out.push({ name, data: buf.slice(start, start + size) });
    i = start + size;
  }
  return out;
}
