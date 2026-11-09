#!/usr/bin/env node
/**
 * tools/probe_bangumi.mjs — Bangumi 数据源探针（M0）
 *
 * 用途：网络打通后，先跑这个脚本，确认三件事能拿到：
 *   1) 今日放送表  GET /calendar
 *   2) 我的「在看」列表  GET /v0/users/{user}/collections
 *   3) 单个条目详情  GET /v0/subjects/{id}
 *
 * 用法：
 *   node tools/probe_bangumi.mjs
 *   node tools/probe_bangumi.mjs --user yourname --subject 400602
 *
 * 环境变量：
 *   BGM_USER    你的 Bangumi 用户名
 *   BGM_TOKEN   access_token（读自己的收藏基本必需）
 *   BGM_BASE    默认 https://api.bgm.tv，被墙时换成反代地址
 *   BGM_PROXY   可选，http://127.0.0.1:7890（走本地代理）
 *
 * 注意：User-Agent 必须形如 app/version (联系方式)，否则 403。
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
  }, [])
);

const BASE = process.env.BGM_BASE || 'https://api.bgm.tv';
const UA = 'ukagaka-bangumi/0.1 (https://github.com/yourname/ukagaka-bangumi)';
const USER = args.user || process.env.BGM_USER || '';
const TOKEN = args.token || process.env.BGM_TOKEN || '';
const PROXY = process.env.BGM_PROXY || '';

// Node 原生 fetch 不认 HTTP_PROXY，需要 undici 的 ProxyAgent
let dispatcher;
if (PROXY) {
  try {
    const { ProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new ProxyAgent(PROXY));
    console.log(`[proxy] ${PROXY}`);
  } catch {
    console.warn('[proxy] 未安装 undici，回退直连：npm i undici');
  }
}

async function api(path, { needToken = false } = {}) {
  const url = path.startsWith('http') ? path : BASE + path;
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (needToken) {
    if (!TOKEN) throw new Error(`${path} 需要 BGM_TOKEN`);
    headers.Authorization = `Bearer ${TOKEN}`;
  }
  const t0 = Date.now();
  const res = await fetch(url, { headers });
  const ms = Date.now() - t0;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${path} (${ms}ms) → ${body.slice(0, 200)}`);
  }
  return { data: await res.json(), ms };
}

const WD = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };

/** JST 放送表 → 中国时区视角。JST 24:00 之后属于 CST 次日凌晨，这里做折算。 */
function jstToCst(airdate) {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/.exec(airdate || '');
  if (!m) return { text: airdate || '?', nextDay: false };
  let [, y, mo, d, hh, mm] = m;
  let H = Number(hh) - 1;           // JST → CST 是 -1 小时
  let nextDay = false;
  if (H < 0) { H += 24; nextDay = true; }
  return { text: `${String(H).padStart(2, '0')}:${mm}`, nextDay, date: `${y}-${mo}-${d}` };
}

async function main() {
  console.log('='.repeat(60));
  console.log(`BASE = ${BASE}`);
  console.log(`USER = ${USER || '(未设置)'}   TOKEN = ${TOKEN ? '已设置' : '(未设置)'}`);
  console.log('='.repeat(60));

  // ---- 1) 每日放送 ----
  try {
    const { data, ms } = await api('/calendar');
    const nowWd = ((new Date().getDay() + 6) % 7) + 1; // JS 周日=0 → 伺か 周一=1
    const today = data.find((d) => d.weekday?.id === nowWd);
    console.log(`\n[1] /calendar OK  ${ms}ms  共 ${data.length} 天`);
    for (const day of data) {
      const mark = day.weekday?.id === nowWd ? ' ← 今天' : '';
      console.log(`    ${WD[day.weekday?.id] || '?'}  ${String(day.items?.length ?? 0).padStart(3)} 部${mark}`);
    }
    if (today?.items?.length) {
      console.log(`\n    今日放送（CST 折算）:`);
      today.items.slice(0, 30).forEach((it, i) => {
        const c = jstToCst(it.air_date);
        const name = it.name_cn || it.name;
        console.log(
          `      ${String(i + 1).padStart(2)}. ${c.text}${c.nextDay ? '(次日)' : ''}  ${name}` +
            `  [id=${it.id} 评分=${it.rating?.score ?? '-'} 排名=${it.rating?.rank ?? '-'}]`
        );
      });
      if (today.items.length > 30) console.log(`      … 还有 ${today.items.length - 30} 部`);
    }
  } catch (e) {
    console.error(`\n[1] /calendar 失败: ${e.message}`);
  }

  // ---- 2) 我的在看 ----
  if (USER) {
    try {
      const { data, ms } = await api(
        `/v0/users/${encodeURIComponent(USER)}/collections?subject_type=2&type=3&limit=50&offset=0`,
        { needToken: !!TOKEN }
      );
      const list = data.data || data;
      console.log(`\n[2] 在看列表 OK  ${ms}ms  共 ${data.total ?? list.length} 部，本页 ${list.length}`);
      list.slice(0, 20).forEach((c) => {
        const s = c.subject || {};
        console.log(
          `      ep ${String(c.ep_status ?? 0).padStart(3)}/${String(s.eps ?? s.eps_count ?? '?').padStart(3)}  ` +
            `${s.name_cn || s.name}  [id=${s.id} 我的评分=${c.rate || '-'}]`
        );
      });
    } catch (e) {
      console.error(`\n[2] 在看列表失败: ${e.message}`);
    }
  } else {
    console.log('\n[2] 跳过（未设置 BGM_USER）');
  }

  // ---- 3) 条目详情 ----
  const sid = args.subject || '400602';
  try {
    const { data, ms } = await api(`/v0/subjects/${sid}`);
    console.log(`\n[3] /v0/subjects/${sid} OK  ${ms}ms`);
    console.log(`      ${data.name_cn || data.name}  评分=${data.rating?.score}  共 ${data.eps ?? data.total_episodes} 话`);
    console.log(`      放送日=${data.date}  封面=${data.images?.large}`);
  } catch (e) {
    console.error(`\n[3] 条目详情失败: ${e.message}`);
  }

  console.log('\n' + '='.repeat(60));
  console.log('探针结束。三项全绿 = 数据层可以开工。');
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
