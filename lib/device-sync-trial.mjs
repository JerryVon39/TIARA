const fields = ['title', 'progress', 'schedule', 'state', 'deleted'];
const states = ['watching', 'planned', 'paused', 'archived', 'dropped'];
const deviceId = value => typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value);
const subjectId = value => typeof value === 'string' && /^(?:[1-9]\d{0,9}|local-[\da-f-]{36})$/i.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const sortKeys = value => Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
const bytesId = op => op.device + ':' + op.sequence;
const clockValue = (clock, device) => Object.hasOwn(clock, device) ? clock[device] : 0;

function fieldValue(name, value) {
  if (name === 'deleted' && typeof value === 'boolean') return value;
  if (name === 'title' && typeof value === 'string' && value.trim() && value.length <= 160) return value.trim();
  if (name === 'state' && states.includes(value)) return value;
  if (name === 'progress' && count(value?.seen) && value.seen <= 10000) {
    const extras = value.extra || [];
    if (Array.isArray(extras) && extras.every(episode => count(episode) && episode > value.seen && episode <= 10000)) {
      let seen = value.seen;
      const remaining = new Set(extras);
      while (remaining.delete(seen + 1)) seen++;
      return { seen, extra: [...remaining].sort((a, b) => a - b) };
    }
  }
  if (name === 'schedule') {
    if (value === null) return null;
    if (Number.isInteger(value?.day) && value.day >= 1 && value.day <= 7 && /^(?:[01]\d|2\d):[0-5]\d$/.test(value.clock))
      return { day: value.day, clock: value.clock };
  }
  throw new Error('不支持迁移此字段或字段值：' + name);
}

function normalOperation(op) {
  if (!op || !deviceId(op.device) || !subjectId(op.subject) || !count(op.sequence) || op.sequence === 0 ||
      !op.seen || typeof op.seen !== 'object' || Array.isArray(op.seen))
    throw new Error('设备、条目或操作编号无效');
  const seen = sortKeys(op.seen);
  if (Object.entries(seen).some(([id, version]) => !deviceId(id) || !count(version)) ||
      clockValue(seen, op.device) !== op.sequence - 1) throw new Error('设备历史不连续');
  if (!op.change || typeof op.change !== 'object' || Array.isArray(op.change) ||
      !Object.keys(op.change).length || Object.keys(op.change).some(key => !fields.includes(key)))
    throw new Error('操作包含未允许迁移的字段');
  const change = Object.fromEntries(fields.filter(name => Object.hasOwn(op.change, name))
    .map(name => [name, fieldValue(name, op.change[name])]));
  return { device: op.device, sequence: op.sequence, subject: String(op.subject).toLowerCase(), seen, change };
}

export function mergeDeviceTrials(...replicas) {
  const merged = new Map();
  for (const operations of replicas) {
    if (!Array.isArray(operations)) throw new Error('设备资料必须是操作清单');
    for (const candidate of operations) {
      const op = normalOperation(candidate);
      const id = bytesId(op);
      if (merged.has(id) && JSON.stringify(merged.get(id)) !== JSON.stringify(op))
        throw new Error('两个设备或副本重复使用了同一操作编号');
      merged.set(id, op);
    }
  }
  const operations = [...merged.values()].sort((a, b) => a.device.localeCompare(b.device) || a.sequence - b.sequence);
  const entries = {};
  const conflicts = [];
  const observed = (later, earlier) => clockValue(later.seen, earlier.device) >= earlier.sequence;
  const bySubject = new Map();
  for (const op of operations) {
    for (const [actor, version] of Object.entries(op.seen)) {
      if (!version) continue;
      const dependency = merged.get(actor + ':' + version);
      if (!dependency) throw new Error('缺少设备修改所依赖的历史');
      if (observed(dependency, op) || Object.entries(dependency.seen).some(([key, value]) => clockValue(op.seen, key) < value))
        throw new Error('设备操作之间的因果关系不一致');
    }
    if (!bySubject.has(op.subject)) bySubject.set(op.subject, []);
    bySubject.get(op.subject).push(op);
  }
  for (const [id, versions] of [...bySubject].sort(([a], [b]) => a.localeCompare(b))) {
    const entry = {};
    entries[id] = entry;
    let tombstones = [];
    for (const field of fields) {
      const writes = versions.filter(op => Object.hasOwn(op.change, field));
      const heads = writes.filter(op => !writes.some(other => observed(other, op)));
      if (!heads.length) continue;
      const variants = new Set(heads.map(item => JSON.stringify(item.change[field])));
      if (variants.size > 1) conflicts.push({ id, field, versions: heads.map(w => ({ operation: bytesId(w), value: w.change[field] })) });
      else entry[field] = heads[0].change[field];
      if (field === 'deleted') {
        tombstones = heads.filter(w => w.change.deleted === true);
        if (tombstones.length) entry.deleted = true;
      }
    }
    const concurrentEdits = versions.filter(edit => !Object.hasOwn(edit.change, 'deleted') &&
      tombstones.some(tombstone => !observed(tombstone, edit) && !observed(edit, tombstone)));
    if (concurrentEdits.length) conflicts.push({ id, field: 'deleted-edit',
      versions: concurrentEdits.map(edit => ({ operation: bytesId(edit), value: edit.change })) });
  }
  return { operations, entries, conflicts };
}

export function deviceTrialChange(device, operations, subject, change) {
  const clock = Object.create(null);
  for (const op of operations) clock[op.device] = Math.max(clockValue(clock, op.device), op.sequence);
  const op = normalOperation({ device, sequence: clockValue(clock, device) + 1, subject, change, seen: clock });
  return [...operations, op];
}
