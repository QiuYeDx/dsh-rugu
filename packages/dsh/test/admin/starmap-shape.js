// 星图（D163）的形状检查：核心 pm.admin.starmap(q) 三种调用的返回值是否合设计 §3.1 的契约。
// 假数据（starmap-fixtures.js）用它验，核心的真实现以后也能拿它验：
//   import { checkStarmapSnapshot, checkStarmapLive, checkStarmapPeek } from '.../starmap-shape.js';
//   assert.deepEqual(checkStarmapSnapshot(pm.admin.starmap({})), []);
// 每个函数返回问题列表（空 = 合契约），每条是「路径：哪里不对」；同一类问题最多报 5 条，免得刷屏。

export const STAR_COLS = Object.freeze(['ref', 'k', 'sub', 't', 't2', 'place', 'who', 'st', 'sup', 'imp', 'cert', 'val', 'b']);
const CERTS = new Set(['s', 'c', 'm', 'h', 'i']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isSafeInteger(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const REF = /^[aet][1-9]\d{0,15}$/;
// 合理的时间（2000 年到 2200 年）
const isTime = (v) => isNum(v) && v > 946_684_800_000 && v < 7_258_118_400_000;

function collector() {
  const out = [];
  const seen = new Map();
  const bad = (path, msg) => {
    const key = `${path.replace(/\[\d+\]/g, '[]')}:${msg}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n <= 5) out.push(`${path}：${msg}`);
  };
  return { out, bad };
}
function sortedBy(list, at, path, bad) {
  for (let i = 1; i < list.length; i++) if (Array.isArray(list[i]) && Array.isArray(list[i - 1]) && list[i][at] < list[i - 1][at]) { bad(`${path}[${i}]`, '没按时间升序'); return; }
}
function checkCursor(c, path, bad) {
  if (!isObj(c)) return bad(path, '应为 {inj, trace, told}');
  for (const k of ['inj', 'trace', 'told']) if (!isInt(c[k]) || c[k] < 0) bad(`${path}.${k}`, '应为非负整数');
}

/** (a) 快照。 */
export function checkStarmapSnapshot(s) {
  const { out, bad } = collector();
  if (!isObj(s)) { bad('', '应为对象'); return out; }
  if (!isTime(s.now)) bad('now', '应为时间（毫秒）');
  if (typeof s.rev !== 'string' || !s.rev) bad('rev', '应为非空字符串');
  checkCursor(s.cursor, 'cursor', bad);
  if (!isObj(s.params) || !(s.params.ageFloorMs > 0) || !(s.params.timeUnitMs > 0)) bad('params', '应为 {ageFloorMs, timeUnitMs}（正数）');
  if (!isInt(s.dropped) || s.dropped < 0) bad('dropped', '应为非负整数');
  if (!isObj(s.counts)) bad('counts', '应为对象');
  else for (const k of ['percepts', 'episode', 'fact', 'plan', 'lesson']) if (!isInt(s.counts[k]) || s.counts[k] < 0) bad(`counts.${k}`, '应为非负整数');

  const people = Array.isArray(s.people) ? s.people : (bad('people', '应为数组'), []);
  people.forEach((p, i) => {
    const at = `people[${i}]`;
    if (!isObj(p)) return bad(at, '应为对象');
    if (!isInt(p.id)) bad(`${at}.id`, '应为整数');
    if (typeof p.name !== 'string' || (!p.name && !p.self)) bad(`${at}.name`, '应为字符串（只有她自己可以是空的）');
    if (typeof p.self !== 'boolean' || typeof p.principal !== 'boolean') bad(at, 'self / principal 应为布尔');
    if (p.closeness != null && !(isNum(p.closeness) && p.closeness >= 0 && p.closeness <= 1)) bad(`${at}.closeness`, '应为 0..1 或 null');
    if (!isInt(p.n) || p.n < 0) bad(`${at}.n`, '应为非负整数');
  });
  const selfs = people.filter((p) => p?.self === true).length;
  // 她自己最多一个，有就排第一（库里没有她的档案时可以没有）
  if (selfs > 1 || (selfs === 1 && people[0]?.self !== true)) bad('people', '她自己最多一个，有的话排第一');
  if (new Set(people.map((p) => p?.id)).size !== people.length) bad('people', 'id 有重复');

  const places = Array.isArray(s.places) ? s.places : (bad('places', '应为数组'), []);
  places.forEach((p, i) => {
    const at = `places[${i}]`;
    if (!isObj(p)) return bad(at, '应为对象');
    if (typeof p.key !== 'string' || !p.key) bad(`${at}.key`, '应为非空字符串');
    for (const k of ['label', 'ownerLabel', 'labelKind', 'adapter', 'hint']) if (!(k in p)) bad(`${at}.${k}`, '缺这一项（没有给 null）');
    if (!(p.oneOnOne === null || typeof p.oneOnOne === 'boolean')) bad(`${at}.oneOnOne`, '应为布尔或 null');
    if (!isInt(p.n) || p.n < 0) bad(`${at}.n`, '应为非负整数');
  });

  const st = s.stars;
  let rows = [];
  if (!isObj(st) || !Array.isArray(st.cols) || !Array.isArray(st.rows)) bad('stars', '应为 {cols, rows}');
  else {
    if (st.cols.join(',') !== STAR_COLS.join(',')) bad('stars.cols', `应为 ${STAR_COLS.join(',')}`);
    rows = st.rows;
  }
  const n = rows.length;
  const refs = new Set();
  rows.forEach((r, i) => {
    const at = `stars.rows[${i}]`;
    if (!Array.isArray(r) || r.length !== STAR_COLS.length) return bad(at, `应为 ${STAR_COLS.length} 列的数组`);
    const [ref, k, sub, t, t2, place, who, sta, sup, imp, cert, val, b] = r;
    if (typeof ref !== 'string' || !REF.test(ref)) bad(`${at}.ref`, '应为 a12 / e34 / t5 这样的引用');
    else if (refs.has(ref)) bad(`${at}.ref`, '重复了');
    else refs.add(ref);
    if (![0, 1, 2, 3].includes(k)) bad(`${at}.k`, '应为 0..3');
    if (typeof ref === 'string') {
      if (ref[0] === 'e' && k !== 0) bad(`${at}.k`, '经历（e）的 k 应为 0');
      if (ref[0] === 't' && (k !== 2 || sub !== 'intention')) bad(`${at}`, "意图（t）的 k 应为 2、sub 应为 'intention'");
      if (ref[0] === 'a' && k === 0) bad(`${at}.k`, '事实（a）的 k 不能是 0');
    }
    if (typeof sub !== 'string' && sub !== null) bad(`${at}.sub`, '应为字符串或 null');
    if (!isTime(t)) bad(`${at}.t`, '应为时间（毫秒）');
    if (t2 !== null && !(isTime(t2) && t2 >= t)) bad(`${at}.t2`, '应为 null 或不早于 t 的时间');
    if (t2 !== null && typeof ref === 'string' && ref[0] !== 'e') bad(`${at}.t2`, '只有经历有 t2');
    if (!isInt(place) || place < -1 || place >= places.length) bad(`${at}.place`, '应为 places 的下标或 -1');
    if (!Array.isArray(who) || who.length > 4 || who.some((w) => !isInt(w) || w < 0 || w >= people.length) || new Set(who).size !== who.length) bad(`${at}.who`, 'people 下标的数组（去重，最多 4 个）');
    if (![0, 1, 2].includes(sta)) bad(`${at}.st`, '应为 0 / 1 / 2');
    if (!isInt(sup) || sup < -1 || sup >= n) bad(`${at}.sup`, '应为星的下标或 -1');
    else if (sup >= 0 && sta !== 1) bad(`${at}`, '有 sup 的星 st 应为 1（被取代）');
    else if (sup === i) bad(`${at}.sup`, '不能取代自己');
    if (imp !== null && !(isNum(imp) && imp >= 0 && imp <= 1)) bad(`${at}.imp`, '应为 0..1 或 null');
    if (cert !== null && !CERTS.has(cert)) bad(`${at}.cert`, '应为 s / c / m / h / i 或 null');
    if (val !== null && !(isNum(val) && val >= -1 && val <= 1)) bad(`${at}.val`, '应为 −1..1 或 null');
    if (b !== null && !isNum(b)) bad(`${at}.b`, '应为数或 null');
  });

  const star = (v) => isInt(v) && v >= 0 && v < n;
  const plc = (v) => isInt(v) && v >= 0 && v < places.length;
  const list = (name) => (Array.isArray(s[name]) ? s[name] : (bad(name, '应为数组'), []));
  const traces = list('traces');
  traces.forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 5) return bad(`traces[${i}]`, '应为 [starIdx, t, w, d, r]');
    if (!star(x[0])) bad(`traces[${i}][0]`, '应为星的下标');
    if (!isTime(x[1])) bad(`traces[${i}][1]`, '应为时间');
    if (!(isNum(x[2]) && x[2] > 0)) bad(`traces[${i}][2]`, 'w 应为正数');
    if (!(isNum(x[3]) && x[3] > 0 && x[3] <= 2)) bad(`traces[${i}][3]`, 'd 应为 0..2 的正数');
    if (!isInt(x[4]) || x[4] < 0 || x[4] > 9) bad(`traces[${i}][4]`, 'r 应为 0..9');
  });
  sortedBy(traces, 1, 'traces', bad);
  const recalls = list('recalls');
  recalls.forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 4) return bad(`recalls[${i}]`, '应为 [ts, placeIdx, [[starIdx, layerCode]…], rawN]');
    if (!isTime(x[0])) bad(`recalls[${i}][0]`, '应为时间');
    if (!(x[1] === -1 || plc(x[1]))) bad(`recalls[${i}][1]`, '应为 places 的下标（或 -1）');
    if (!Array.isArray(x[2]) || x[2].some((it) => !Array.isArray(it) || it.length !== 2 || !star(it[0]) || ![0, 1, 2].includes(it[1]))) bad(`recalls[${i}][2]`, '应为 [[starIdx, 0|1|2]…]');
    if (!isInt(x[3]) || x[3] < 0) bad(`recalls[${i}][3]`, 'rawN 应为非负整数');
    if (Array.isArray(x[2]) && !x[2].length && x[3] === 0) bad(`recalls[${i}]`, '一颗星都没有、rawN 也是 0 的不要');
  });
  sortedBy(recalls, 0, 'recalls', bad);
  const tells = list('tells');
  tells.forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 4) return bad(`tells[${i}]`, '应为 [at, placeIdx, starIdx, 0|1]');
    if (!isTime(x[0])) bad(`tells[${i}][0]`, '应为时间');
    if (!(x[1] === -1 || plc(x[1]))) bad(`tells[${i}][1]`, '应为 places 的下标（或 -1）');
    if (!star(x[2])) bad(`tells[${i}][2]`, '应为星的下标');
    if (x[3] !== 0 && x[3] !== 1) bad(`tells[${i}][3]`, '应为 0 / 1');
  });
  sortedBy(tells, 0, 'tells', bad);
  const mood = list('mood');
  if (mood.length > 2000) bad('mood', '最多 2000 个点');
  mood.forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 3 || !isTime(x[0]) || !(isNum(x[1]) && x[1] >= -1 && x[1] <= 1) || !(isNum(x[2]) && x[2] >= 0 && x[2] <= 1)) bad(`mood[${i}]`, '应为 [at, −1..1, 0..1]');
  });
  sortedBy(mood, 0, 'mood', bad);
  list('heard').forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 4 || !plc(x[0]) || !isTime(x[1]) || x[1] % 3_600_000 !== 0 || !isInt(x[2]) || x[2] < 1 || !isInt(x[3]) || x[3] < 0 || x[3] > x[2]) {
      bad(`heard[${i}]`, '应为 [placeIdx, 整点 ms, n ≥ 1, 0 ≤ nToHer ≤ n]');
    }
  });
  const nights = list('nights');
  nights.forEach((x, i) => { if (!isTime(x)) bad(`nights[${i}]`, '应为时间'); });
  for (let i = 1; i < nights.length; i++) if (nights[i] < nights[i - 1]) { bad('nights', '应按时间升序'); break; }
  if (s.t0 != null || n) {
    if (!isTime(s.t0)) bad('t0', '应为时间');
    else if (rows.some((r) => Array.isArray(r) && r[3] < s.t0)) bad('t0', '应不晚于最早一颗星');
  }
  if (people.length) {
    const homes = new Map();
    for (const r of rows) if (Array.isArray(r) && Array.isArray(r[6]) && r[6].length) homes.set(r[6][0], (homes.get(r[6][0]) ?? 0) + 1);
    people.forEach((p, i) => { if (isInt(p?.n) && p.n !== (homes.get(i) ?? 0)) bad(`people[${i}].n`, `应等于以他为家的星数（${homes.get(i) ?? 0}）`); });
  }
  return out;
}

/** (b) 实时增量：引用代替下标，场合用 key。 */
export function checkStarmapLive(s) {
  const { out, bad } = collector();
  if (!isObj(s)) { bad('', '应为对象'); return out; }
  if (!isTime(s.now)) bad('now', '应为时间');
  if (typeof s.rev !== 'string' || !s.rev) bad('rev', '应为非空字符串');
  checkCursor(s.cursor, 'cursor', bad);
  for (const k of ['traces', 'recalls', 'tells']) if (!Array.isArray(s[k])) bad(k, '应为数组');
  else if (s[k].length > 500) bad(k, '最多 500 行');
  (s.traces ?? []).forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 5 || !REF.test(String(x[0])) || !isTime(x[1]) || !(x[2] > 0) || !(x[3] > 0) || !isInt(x[4])) bad(`traces[${i}]`, '应为 [ref, t, w, d, r]');
  });
  (s.recalls ?? []).forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 4 || !isTime(x[0]) || !(typeof x[1] === 'string' || x[1] === null) || !Array.isArray(x[2])
      || x[2].some((it) => !Array.isArray(it) || !REF.test(String(it[0])) || ![0, 1, 2].includes(it[1])) || !isInt(x[3])) bad(`recalls[${i}]`, '应为 [ts, placeKey, [[ref, layerCode]…], rawN]');
  });
  (s.tells ?? []).forEach((x, i) => {
    if (!Array.isArray(x) || x.length !== 4 || !isTime(x[0]) || !(typeof x[1] === 'string' || x[1] === null) || !REF.test(String(x[2])) || (x[3] !== 0 && x[3] !== 1)) bad(`tells[${i}]`, '应为 [at, placeKey, ref, 0|1]');
  });
  for (const k of ['recalls', 'tells']) if (Array.isArray(s[k])) sortedBy(s[k], 0, k, bad);
  if (Array.isArray(s.traces)) sortedBy(s.traces.map((x) => [x?.[1]]), 0, 'traces', bad);
  return out;
}

/** (c) 看一眼。 */
export function checkStarmapPeek(s, asked = null) {
  const { out, bad } = collector();
  if (!isObj(s) || !Array.isArray(s.items)) { bad('items', '应为数组'); return out; }
  if (s.items.length > 24) bad('items', '最多 24 条');
  s.items.forEach((x, i) => {
    if (!isObj(x) || !REF.test(String(x.ref))) return bad(`items[${i}]`, '应为 {ref, title, text, at}');
    if (asked && !asked.includes(x.ref)) bad(`items[${i}].ref`, '没问的引用');
    if (!(x.title === null || typeof x.title === 'string')) bad(`items[${i}].title`, '应为字符串或 null');
    if (typeof x.text !== 'string') bad(`items[${i}].text`, '应为字符串');
    else if ([...x.text].length > 400) bad(`items[${i}].text`, '太长');
    if (!(x.at === null || isTime(x.at))) bad(`items[${i}].at`, '应为时间或 null');
  });
  return out;
}
