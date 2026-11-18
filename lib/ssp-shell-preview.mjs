import fs from 'node:fs/promises';
import path from 'node:path';
import { isPng } from './cover.mjs';

const pngName = value => typeof value === 'string' && /^[^./\\:*?"<>|\x00-\x1f][^/\\:*?"<>|\x00-\x1f]*\.png$/i.test(value);
const validCoord = value => /^-?\d{1,4}$/.test(value);
const byIndex = (a, b) => a.index - b.index;

function decodeSurfaces(input) {
  if (input.length > 2 * 1024 * 1024) throw new Error('surfaces.txt 超出 2 MiB 预览范围');
  try { return { encoding: 'UTF-8', text: new TextDecoder('utf-8', { fatal: true }).decode(input) }; }
  catch { return { encoding: 'Shift_JIS', text: new TextDecoder('shift_jis', { fatal: true }).decode(input) }; }
}

function readDefinitions(text, id, warnings) {
  const selected = { layers: [], collisions: [] };
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s*\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^surface/i.test(line)) {
      const simple = /^surface(\d+)\s*\{?$/i.exec(line);
      section = simple && Number(simple[1]) === id ? 'target' : '';
      if (!simple) warnings.add('复合或追加 surface 定义留在 SSP 内使用。');
      continue;
    }
    if (line === '}') { section = ''; continue; }
    if (section !== 'target' || line === '{') continue;
    const [key, ...values] = line.split(',').map(item => item.trim());
    const element = /^element(\d+)$/i.exec(key);
    if (element) {
      const [mode, file, x, y] = values;
      if (!(mode === 'overlay' || mode === 'base' && Number(element[1]) === 0) || !pngName(file) ||
          !validCoord(x) || !validCoord(y)) throw new Error('无法静态转换：' + key + '。请使用本目录的 PNG 和 overlay 整数坐标。');
      selected.layers.push({ index: Number(element[1]), file, x: Number(x), y: Number(y) });
      continue;
    }
    const collision = /^collision(\d+)$/i.exec(key);
    if (collision) {
      const [x, y, right, bottom, name] = values;
      if (![x, y, right, bottom].every(validCoord) || +right <= +x || +bottom <= +y || !name)
        throw new Error('碰撞区的坐标或名称无效：' + key);
      selected.collisions.push({ index: Number(collision[1]), name, x: +x, y: +y, width: +right - +x, height: +bottom - +y });
      continue;
    }
    if (/animation|interval|pattern|collisionex|\d+interval|bind/i.test(key)) warnings.add('动画、换装绑定及非矩形碰撞区由 SSP 保留。');
  }
  return selected;
}

async function loadLayer(directory, layer) {
  const source = path.join(directory, layer.file);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error('找不到本地图片 ' + layer.file);
  if (stat.size > 12 * 1024 * 1024) throw new Error('图片超过 12 MiB：' + layer.file);
  const data = await fs.readFile(source);
  if (!isPng(data)) throw new Error(layer.file + ' 不是完整的 PNG');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('图片尺寸超出预览范围：' + layer.file);
  return { ...layer, width, height, data };
}

export async function inspectSspShell(directory, id = 0) {
  if (!Number.isSafeInteger(id) || id < 0 || id > 99999) throw new Error('surface 编号无效');
  const original = await fs.readFile(path.join(directory, 'surfaces.txt')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const warnings = new Set();
  const definition = original ? decodeSurfaces(original) : { encoding: null, text: '' };
  const { layers, collisions } = readDefinitions(definition.text, id, warnings);
  if (layers.length > 16 || collisions.length > 64 ||
      new Set(layers.map(item => item.index)).size !== layers.length ||
      new Set(collisions.map(item => item.index)).size !== collisions.length)
    throw new Error('图层或碰撞区编号重复，或者数量超出预览范围');
  if (!layers.some(layer => layer.index === 0)) {
    const name = 'surface' + id + '.png';
    const file = await fs.stat(path.join(directory, name)).catch(() => null);
    if (file?.isFile() || !layers.length) layers.unshift({ index: -1, file: name, x: 0, y: 0 });
  }
  const loaded = await Promise.all(layers.sort(byIndex).map(layer => loadLayer(directory, layer)));
  const left = Math.min(0, ...loaded.map(layer => layer.x));
  const top = Math.min(0, ...loaded.map(layer => layer.y));
  const width = Math.max(...loaded.map(layer => layer.x + layer.width)) - left;
  const height = Math.max(...loaded.map(layer => layer.y + layer.height)) - top;
  if (width > 4096 || height > 4096 || width <= 0 || height <= 0) throw new Error('合成画布超出预览范围');
  return { id, encoding: definition.encoding, canvas: { left, top, width, height }, layers: loaded, collisions: collisions.sort(byIndex), warnings: [...warnings] };
}

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderSspPreview(plan) {
  const { left, top, width, height } = plan.canvas;
  const layers = plan.layers.map(layer => '<img alt="' + escape(layer.file) + '" style="left:' +
    ((layer.x - left) / width * 100) + '%;top:' + ((layer.y - top) / height * 100) + '%;width:' +
    (layer.width / width * 100) + '%" src="data:image/png;base64,' + layer.data.toString('base64') + '">');
  const boxes = plan.collisions.map(rect => '<span class="hit" style="left:' + ((rect.x - left) / width * 100) +
    '%;top:' + ((rect.y - top) / height * 100) + '%;width:' + (rect.width / width * 100) +
    '%;height:' + (rect.height / height * 100) + '%">' + escape(rect.name) + '</span>');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>SSP 立绘预览</title><style>body{margin:28px;font:16px system-ui;color:#263440;background:#f7f8fa}' +
    '.view{margin:14px 0;position:relative;width:min(100%,520px);overflow:hidden;background:#e7f2f8;border-radius:12px}' +
    'img,.hit{position:absolute}.hit{box-sizing:border-box;border:2px solid #1c6588;background:#ffffff70;color:#123847;font-size:13px}' +
    'p{max-width:50em}</style><h1>SSP 立绘预览</h1><p>surface' + plan.id + ' · ' + width + ' × ' + height +
    ' · ' + plan.layers.length + ' 个图层，' + plan.collisions.length + ' 个矩形碰撞区</p>' +
    '<figure class="view" style="aspect-ratio:' + width + '/' + height + '">' + layers.join('') + boxes.join('') + '</figure>' +
    plan.warnings.map(warning => '<p>' + escape(warning) + '</p>').join('') + '</html>\n';
}
