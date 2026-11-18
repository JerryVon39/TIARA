import { createHash } from 'node:crypto';
import { libraryMatches, titleKey } from './watch-matches.mjs';
import { editWatchDetail } from './watch-detail.mjs';
import { findWatchEntry } from './watch-lifecycle.mjs';

export const CSV_BYTES = 512 * 1024;
export const CSV_HEADERS = ['标题', '已看集数', '总集数', '年份', 'Bangumi编号'];
const CSV_ROWS = 200;

function readRows(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > CSV_BYTES) throw new Error('请选择 512 KiB 以内的 UTF-8 CSV');
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows = [];
  let record = [], field = '', quoted = false, closed = false, line = 1, rowLine = 1;
  function finishField() {
    record.push(field.trim());
    field = '';
    closed = false;
    if (record.length > CSV_HEADERS.length) throw new Error('第 ' + rowLine + ' 行有多余栏位');
  }
  function finishRow() {
    finishField();
    if (record.some(Boolean)) {
      rows.push({ line: rowLine, fields: record });
      if (rows.length > CSV_ROWS + 1) throw new Error('一次最多预览 ' + CSV_ROWS + ' 行番剧资料');
    }
    record = [];
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"' && source[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',') finishField();
    else if (c === '\n') { finishRow(); rowLine = line + 1; }
    else if (closed || c === '"' && field.length) throw new Error('第 ' + line + ' 行的引号格式不正确');
    else if (c === '"') quoted = true;
    else field += c;
    if (c === '\n') line++;
  }
  if (quoted) throw new Error('第 ' + rowLine + ' 行的引号未闭合');
  finishRow();
  const header = rows.shift()?.fields;
  if (!header || header.length !== CSV_HEADERS.length || CSV_HEADERS.some((name, i) => header[i] !== name))
    throw new Error('CSV 表头须使用模板中的五列');
  if (!rows.length) throw new Error('CSV 中没有番剧资料');
  return rows;
}

function parseRow({ line, fields }) {
  const [name = '', seenRaw = '', totalRaw = '', yearRaw = '', idRaw = ''] = fields;
  const row = { line, name: name.slice(0, 160) };
  const invalid = error => ({ ...row, action: 'invalid', error });
  if (!name || !titleKey(name) || name.length > 160 || /[\x00-\x1f\x7f\ufffd]/.test(name)) return invalid('请填写有效的单行标题');
  const whole = value => /^\d{1,5}$/.test(value);
  const seen = seenRaw ? Number(seenRaw) : 0;
  const total = totalRaw ? Number(totalRaw) : null;
  if ((seenRaw && !whole(seenRaw)) || (totalRaw && (!whole(totalRaw) || total < 1 || seen > total)))
    return invalid('请核对已看集数和总集数');
  const year = yearRaw ? Number(yearRaw) : null;
  if (yearRaw && (!/^\d{4}$/.test(yearRaw) || year < 1900 || year > 2200)) return invalid('年份须在 1900 到 2200 之间');
  if (idRaw && !/^[1-9]\d{0,9}$/.test(idRaw)) return invalid('Bangumi 编号须为 1–10 位正整数');
  return { ...row, seen, total, year, id: idRaw || null, state: seen === 0 ? 'planned' : seen === total ? 'finished' : 'catchup' };
}

export function previewCsvImport(library, csv) {
  const earlier = { planned: [] };
  const rows = readRows(csv).map(source => {
    const row = parseRow(source);
    if (row.action === 'invalid') return row;
    const candidate = { id: row.id, name_cn: row.name, user_details: { year: row.year } };
    const matches = libraryMatches(library, candidate);
    const fileMatches = libraryMatches(earlier, candidate);
    if (matches.length || fileMatches.length) return {
      ...row, action: 'duplicate', matches: matches.slice(0, 5),
      earlier: fileMatches.map(item => earlier.planned.find(entry => String(entry.id) === item.id).line).slice(0, 5)
    };
    earlier.planned.push({ ...candidate, id: row.id || 'csv-' + row.line, line: row.line });
    return { ...row, action: 'add' };
  });
  const revision = createHash('sha256').update(JSON.stringify([library, csv])).digest('hex');
  return { rows, revision };
}

export function applyCsvImport(library, rows, selected) {
  const additions = new Map(rows.filter(row => row.action === 'add').map(row => [row.line, row]));
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(line => !additions.has(line)))
    throw new Error('请从预览中选择可导入的行');
  const created = [];
  for (const line of selected) {
    const row = additions.get(line);
    const input = { name: row.name, eps: row.total, ep_status: row.seen, watch_mode: 'catchup',
      ...(row.id ? { subject_id: Number(row.id) } : {}), ...(row.state === 'planned' ? { planned: true } : {}) };
    const edited = editWatchDetail(library, input);
    if (!edited.added) throw new Error(edited.error || '无法新增第 ' + line + ' 行');
    if (row.year) findWatchEntry(library, edited.detail.id).entry.user_details = { year: row.year };
    created.push(edited.detail.id);
  }
  return created;
}
