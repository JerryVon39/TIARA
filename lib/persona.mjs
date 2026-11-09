/**
 * 人格与称呼
 *
 * 这个文件只回答一个问题：**她该怎么叫你**。
 *
 * 设计约定：
 *   1. 一般场合一律用「称呼」（`{nickname}` 占位符），由用户在库里改，默认「会長」；
 *   2. 少数场合有固定说法，不跟着称呼走——生气叫「不届き者」、慌张自称「副会長」——
 *      这些写在台词里，不走占位符（RESERVED_TERMS 只用于文档 / 校验，不影响渲染）；
 *   3. 称呼是**用户数据**，存在 `data/library.json` 的 `user.nickname_for_pet`，
 *      不进 `settings.json`（那是设备偏好；换台机器应该还是「会長」，除非你改库）。
 */

/** 默认称呼：她是副会长，你是她管着的会长——这个错位本身就是设定 */
export const DEFAULT_NICKNAME = '会長';

/** 有固定说法的场合（不跟随自定义称呼） */
export const RESERVED_TERMS = {
  angry: '不届き者',
  selfRef: '副会長',
  club: '生徒会',
};

const MAX_LEN = 12;

/**
 * 校验并规整用户输入的称呼。
 * 返回 `{ ok: true, value }` 或 `{ ok: false, error }`。
 *
 * 限制不严：中文、日文、英文、数字、空格都行，但不要换行/制表符（会撑坏气泡），
 * 也不要太长（气泡宽度有限，12 个字已经够长）。
 */
export function normalizeNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '称呼必须是字符串' };
  const s = raw.replace(/[\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, error: '称呼不能为空' };
  if ([...s].length > MAX_LEN) return { ok: false, error: `称呼最多 ${MAX_LEN} 个字` };
  if (/[{}]/.test(s)) return { ok: false, error: '称呼里不能有花括号（会和占位符打架）' };
  return { ok: true, value: s };
}

/** 从番组库里取当前称呼（读不到就用默认值） */
export function addressOf(lib) {
  const v = lib?.user?.nickname_for_pet;
  const r = normalizeNickname(v);
  return r.ok ? r.value : DEFAULT_NICKNAME;
}

/** 给面板 `/api/state` 用的一小包信息 */
export function personaInfo(lib) {
  return {
    address: addressOf(lib),
    default: DEFAULT_NICKNAME,
    reserved: RESERVED_TERMS,
    max_len: MAX_LEN,
  };
}
