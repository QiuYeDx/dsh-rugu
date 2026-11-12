// 星图（D163）的假数据：照核心 pm.admin.starmap(q) 的契约（设计 §3.1）编一份「像真的」记忆星空，给测试和预览用。
// 名字、群名、内容全是编的。确定性：同一个种子、同一个「现在」每次一样（截图可复现）。
//   makeStarmap({now, size: 'normal' | 'big'})  → {snapshot(nowMs), live(since, nowMs), peek(refs)}
// normal：约 1500 颗星、她自己 + 主人 + 7 个别人、4 个场合（1 私聊、2 群、1 桌面会话）、跨 12 天，白天密夜里稀，
//   每晚 04:30（北京时间）一批 replay；几十对被取代的、过时的计划、没到点的意图、上千条想起、几百条说起、心境、听到的话。
// big：约 2 万颗星、30 多个人、60 天（量性能用）。
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const BJ = 8 * HOUR;

/** 确定的伪随机数（mulberry32）。 */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 北京时间一天 24 小时里，她这边有多热闹（相对值）。 */
const ACTIVITY = [0.55, 0.3, 0.12, 0.05, 0.03, 0.03, 0.06, 0.25, 0.55, 0.75, 0.85, 0.95, 1, 0.8, 0.8, 0.8, 0.85, 0.9, 1, 1.1, 1.3, 1.4, 1.25, 0.95];
const bjHour = (t) => new Date(t + BJ).getUTCHours();
/** 按白天黑夜的节奏挑一个时刻：先挑哪一天（越近越多），再按 ACTIVITY 挑钟点。 */
function pickTime(R, start, end, recentBias = 0.6) {
  for (let k = 0; k < 40; k++) {
    const u = Math.pow(R(), 1 - recentBias * 0.5);
    const t = end - (1 - u) * (end - start);
    if (R() * 1.4 < ACTIVITY[bjHour(t)]) return Math.round(t);
  }
  return Math.round(start + R() * (end - start));
}
const pick = (R, xs) => xs[Math.floor(R() * xs.length)];
function weighted(R, ws) {
  const sum = ws.reduce((a, b) => a + b, 0);
  let x = R() * sum;
  for (let i = 0; i < ws.length; i++) { x -= ws[i]; if (x <= 0) return i; }
  return ws.length - 1;
}
/** 小的泊松数。 */
function poisson(R, mean) {
  const L = Math.exp(-mean); let k = 0; let p = 1;
  do { k++; p *= R(); } while (p > L && k < 50);
  return k - 1;
}

const OTHER_NAMES = ['阿明', '小雨', '老周', '可乐', '阿青', '小鹿', '团子'];
const MORE_NAMES = ['大宇', '小北', '阿洛', '星星', '木木', '十一', '小满', '阿远', '豆豆', '七七', '阿哲', '小橙', '阿九', '米粒', '老白', '阿凯', '小葵', '阿树', '阿冬', '小舟',
  '糖糖', '阿川', '小禾', '阿宁', '老唐', '小柚', '阿默'];
// 场合（编的）：一个私聊、两个群、一个 DSH 桌面会话。形状照核心 settings 的那几列（起名字是集成层的事）
const PLACES = [
  { key: 'sk-private-owner', label: '和你的私聊', ownerLabel: null, labelKind: 'description', adapter: 'qq', hint: null, oneOnOne: true },
  { key: 'sk-group-small', label: '摸鱼小群', ownerLabel: null, labelKind: 'name', adapter: 'qq', hint: '8 人 · Qa7c', oneOnOne: false },
  { key: 'sk-group-big', label: '一个 QQ 群', ownerLabel: '周末开黑群', labelKind: 'description', adapter: 'qq', hint: '420 人 · Lm2v', oneOnOne: false },
  { key: 'sk-group-book', label: '周三读书会（大家轮流领读，一直读到很晚的那个群）', ownerLabel: null, labelKind: 'name', adapter: 'qq', hint: null, oneOnOne: null },
  { key: 'sk-web', label: '和你的 DSH 聊天', ownerLabel: null, labelKind: 'description', adapter: 'dsh-web', hint: null, oneOnOne: true },
];
const NP = PLACES.length;
/** normal 的人（和真实库的分布一个样子）：她自己、主人之外 26 个人，星数长尾，有的名字很长。 */
const TAIL_NAMES = [...OTHER_NAMES, '住在隔壁楼的那个摄影师大叔', ...MORE_NAMES.slice(0, 18)];
const TAIL = [108, 83, 50, 47, 41, 35, 33, 30, 26, 25, 22, 20, 13, 13, 10, 9, 8, 5, 3, 2, 2, 2, 1, 1, 1, 1];

// 内容模板（编的）：{n} = 有关的人
const FACTS = ['{n}在学做饭，最近迷上了番茄炖牛腩', '{n}养了一只橘猫，叫团团', '{n}周末喜欢去江边骑车', '{n}不吃香菜', '{n}的生日在三月', '{n}在玩一款新出的解谜游戏，卡在第三章',
  '{n}最近换了工作，通勤要一个小时', '{n}说楼下新开了一家面馆，味道一般', '{n}喜欢听老歌，尤其是九十年代的', '{n}怕冷，冬天总穿得很厚', '{n}在准备驾照科目二', '{n}的表哥开网约车',
  '{n}觉得早上的会太多了', '{n}最近在读一本讲星空的书', '{n}说家里的路由器老掉线'];
const SELF_FACTS = ['我更喜欢先听大家说完再开口', '我记不住太长的数字，最好写下来', '我在每个群都能收到消息', '我喜欢下雨天', '我说话直来直去，有时候会显得冷淡', '我答应过的事会记着'];
const PLANS = ['周五提醒{n}去取快递', '下周一起看那部新上映的电影', '帮{n}记着体检的时间', '周末前把歌单整理好发给{n}', '月底和{n}一起去看展', '晚上八点提醒{n}吃药'];
const LESSONS = ['消息超过 500 字先分成几段再发', '别人问别的群里的事，先回想一下再回答', '读文件之前先确认路径存在', '聊游戏时别剧透', '发图片前先确认图片还在', '大家吵起来时先别站队'];
const EPISODES = ['和{n}聊到半夜，说起小时候的事', '{n}在群里发了一张晚霞的照片，大家都在夸', '帮{n}查了明天的天气', '{n}讲了个冷笑话，群里安静了三秒', '和{n}一起想周末去哪儿',
  '{n}说考试过了，大家刷了一排恭喜', '陪{n}聊了聊工作上的烦心事', '{n}分享了一首歌，她听了两遍', '群里在争论豆花该是甜的还是咸的', '{n}问她记不记得上周说的那家店'];
const INTENTS = ['问问{n}周末那场比赛怎么样了', '问问{n}快递拿到没有', '提醒{n}明天降温', '问问{n}科目二考过了没有', '跟{n}说那本书看完了'];
const LONG = '{n}说下个月要搬去另一个城市工作，房子已经在看了，但是还没跟家里人说，让她先别到处讲；顺便提到周末那场比赛他们队赢了，还拿了一个奖杯，打算放在新家的书架上。这一句故意写得很长，用来看提示框和详情卡的换行。';

const COLS = ['ref', 'k', 'sub', 't', 't2', 'place', 'who', 'st', 'sup', 'imp', 'cert', 'val', 'b'];

/**
 * @param {{now: number, size?: 'normal'|'big', seed?: number}} o
 */
export function makeStarmap({ now, size = 'normal', seed = 2026 }) {
  const big = size === 'big';
  const R = rng(seed);
  const days = big ? 60 : 10;
  const start = now - days * DAY;
  const N = big ? 20_000 : 2000;

  // ── 人：她自己第一，主人，然后别人（按亲疏） ──
  const others = big ? [...TAIL_NAMES, ...MORE_NAMES.slice(18).map((x) => `${x}二号`), ...MORE_NAMES.slice(0, 6).map((x) => `老${x}`)] : TAIL_NAMES;
  const persons = [
    { id: 1, name: '她', self: true, principal: false, closeness: null },
    { id: 2, name: '主人', self: false, principal: true, closeness: 1 },
    // 真实库里除了她和主人，所有人的 closeness 都是 0
    ...others.map((name, i) => ({ id: 10 + i, name, self: false, principal: false, closeness: 0 })),
  ];
  // 家的权重：她自己、主人占大头，别人几十颗（越亲越多），少数没认出是谁
  const homeW = big ? [8360, 5410, ...others.map((_, i) => 1080 * Math.pow(0.83, i))] : [836, 541, ...TAIL];
  const NONE_W = 0.004;

  // ── 星 ──
  const stars = [];
  for (let i = 0; i < N; i++) {
    const hi = R() < NONE_W ? -1 : weighted(R, homeW);
    const t = pickTime(R, start + 30 * MIN, now - 10 * MIN, 0.75);
    // 种类：经历 / 知道的事 / 约定和打算 / 做事的经验；做事的经验多半是她自己的
    let k = weighted(R, hi === 0 ? [0.3, 0.55, 0.1, 0.02] : [0.36, 0.52, 0.115, 0.005]);
    let intention = false;
    if (k === 2 && R() < 0.22) intention = true;
    // 场合：主人的多在私聊和桌面，别人的多在群里
    // 场合：私聊、小群、大群、读书会、桌面（桌面会话很少）
    const placeW = hi === 1 ? [0.4, 0.25, 0.17, 0.14, 0.04] : hi === 0 ? [0.08, 0.36, 0.3, 0.24, 0.02] : hi === -1 ? [0, 0.4, 0.4, 0.2, 0] : [0.02, 0.42, 0.38, 0.18, 0];
    const place = R() < 0.006 ? -1 : weighted(R, placeW);
    const who = [];
    if (hi >= 0) who.push(hi);
    // 两个人一起的事：两团之间的桥
    // 两个人一起的事：两团之间的桥（1 个人 84%、2 个人 9%、3 个人 3%、4 个人 2%）
    const other = () => 2 + Math.floor(Math.pow(R(), 1.6) * others.length);
    if (hi >= 0 && R() < (k === 0 ? 0.3 : 0.1)) {
      const second = R() < 0.35 && hi !== 1 ? 1 : R() < 0.3 && hi !== 0 ? 0 : other();
      if (second !== hi && second < persons.length) who.push(second);
      for (let x = 0; x < 2 && R() < 0.4; x++) { const more = other(); if (!who.includes(more)) who.push(more); }
    }
    stars.push({ k, intention, t, place, who, hi });
  }
  stars.sort((a, b) => a.t - b.t);
  let na = 0; let ne = 0; let nt = 0;
  for (const s of stars) {
    s.ref = s.k === 0 ? `e${++ne}` : s.intention ? `t${++nt}` : `a${++na + 100}`;
    s.sub = s.k === 0 ? (R() < 0.08 ? 'diary' : 'event') : s.intention ? 'intention' : s.k === 3 ? 'lesson' : s.k === 2 ? pick(R, ['plan', 'plan', 'commitment', 'rule']) : pick(R, ['fact', 'state', 'preference', 'fact', 'identity']);
    s.t2 = s.k === 0 ? s.t + Math.round((8 + R() * 80) * MIN) : null;
    if (s.t2 != null && s.t2 > now) s.t2 = now - MIN;
    s.st = 0; s.sup = -1;
    s.imp = s.k === 0 ? (R() < 0.2 ? null : Math.round((0.15 + R() * 0.8) * 100) / 100) : s.intention ? null : Math.round(3 + R() * 6) / 10;
    s.cert = s.k === 0 || s.intention ? null : s.hi === 0 ? (R() < 0.7 ? 'm' : 'c') : s.hi === 1 ? pick(R, ['s', 's', 's', 'c', 'i']) : pick(R, ['s', 's', 'h', 'h', 'i']);
    s.val = s.k === 0 && R() < 0.85 ? Math.round((R() * 1.5 - 0.6) * 100) / 100 : null;
    s.b = R() < 0.9 ? null : Math.round((-2.5 + R() * 2) * 100) / 100;
  }
  const idxOf = new Map(stars.map((s, i) => [s, i]));
  // 被取代：同一个家、同一类的后一条取代前一条（几十对）
  const facts = stars.filter((s) => s.k === 1 && s.hi >= 0);
  const pairs = big ? 600 : 46;
  const taken = new Set();
  for (let p = 0; p < pairs; p++) {
    const a = facts[Math.floor(R() * facts.length * 0.85)];
    if (a.st !== 0) continue;
    const later = [];
    for (const x of facts) { if (x.hi === a.hi && x.t > a.t + 2 * HOUR && x.st === 0 && !taken.has(x)) { later.push(x); if (later.length >= 12) break; } }
    if (!later.length) continue;
    const b = later[Math.floor(R() * Math.min(later.length, 12))];
    a.st = 1; a.sup = idxOf.get(b); taken.add(b);
  }
  // 过时：做完 / 取消 / 错过的计划，执行过的意图；最近两天形成的意图还没到点（会呼吸）
  for (const s of stars) {
    if (s.st) continue;
    if (s.intention) s.st = s.t < now - 2 * DAY ? (R() < 0.85 ? 2 : 0) : (R() < 0.25 ? 2 : 0);
    else if (s.k === 2 && s.t < now - 3 * DAY && R() < 0.5) s.st = 2;
    else if (s.k === 1 && R() < 0.02) s.st = 2;
  }

  // ── 痕迹 ──
  const traces = [];
  const tr = (i, t, w, d, r) => { if (t <= now) traces.push([i, Math.round(t), Math.round(w * 1000) / 1000, Math.round(d * 1000) / 1000, r]); };
  stars.forEach((s, i) => {
    const deep = s.hi === 1 || s.hi === 0 ? 1 : 0.6 + R() * 0.3;
    // 约 3.6% 的星没有任何痕迹（页面用 b 兜底）
    if (R() < 0.036) { if (s.b == null) s.b = Math.round((-2.4 + R() * 1.6) * 100) / 100; return; }
    tr(i, s.t2 ?? s.t, s.k === 0 ? Math.min(1, deep + 0.1) : deep * (0.7 + (s.imp ?? 0.5) * 0.4), 0.3, 0);
    // 后来被提起、确认、被问到：真实库里很少
    const more = R() < 0.012 ? 1 + poisson(R, 0.6) : 0;
    let t = s.t2 ?? s.t;
    for (let j = 0; j < more; j++) {
      t += (0.3 + R() * R() * 60) * HOUR;
      if (t > now) break;
      tr(i, t, 0.35 + R() * 0.5, 0.45 + R() * 0.45, pick(R, [1, 1, 2, 3, 4, 5]));
    }
    // 老的星：一条折叠掉的伪痕迹（agg_bins 的一箱）
    if (s.t < now - 6 * DAY && R() < 0.02) tr(i, s.t + (4 + R() * 30) * HOUR, 0.8 + R() * 1.4, 0.5, 9);
  });
  // 取代者继承一条
  stars.forEach((s) => { if (s.sup >= 0) tr(s.sup, stars[s.sup].t + MIN, 0.6, 0.4, 8); });
  // 夜间整理：每晚 04:30（北京时间）一批 replay（重放最近一天的、加上随机几条老的）
  const nights = [];
  for (let d = Math.floor((start + BJ) / DAY) + 1; ; d++) {
    const n = d * DAY - BJ + 4.5 * HOUR;
    if (n > now) break;
    if (n < start + 6 * HOUR) continue;
    nights.push(n);
    let picked = 0;
    stars.forEach((s, i) => {
      if (s.t > n) return;
      const fresh = s.t > n - 30 * HOUR;
      if (R() < (fresh ? 0.085 : 0.002)) { tr(i, n + R() * 25 * MIN, 0.5, 0.5, 7); picked++; }
    });
  }

  // ── 想起（injections）：上千条，三种层，很多是在别的场合记下的 ──
  const recalls = [];
  const byPlace = PLACES.map((_, p) => p).map((p) => stars.map((s, i) => [s, i]).filter(([s]) => s.place === p));
  const nRec = big ? 8000 : 1134;
  const recentOf = (list, t) => list.filter(([s]) => s.t <= t);
  for (let r = 0; r < nRec; r++) {
    const ts = pickTime(R, start + 3 * HOUR, now - MIN, 0.7);
    const place = weighted(R, [0.22, 0.3, 0.26, 0.18, 0.04]);
    const n = weighted(R, [0.05, 0.4, 0.3, 0.15, 0.1]);
    const items = [];
    for (let j = 0; j < n; j++) {
      const cross = R() < 0.33;
      const pool = cross ? byPlace[weighted(R, PLACES.map((_, p) => (p === place ? 0 : 1)))] : byPlace[place];
      const born = big ? null : recentOf(pool, ts);
      const list = born ?? pool;
      if (!list.length) continue;
      // 偏向最近的（年轮外圈），也有很久以前的
      const u = R() < 0.6 ? 1 - R() * R() * 0.4 : R();
      let cand = list[Math.min(list.length - 1, Math.floor(u * list.length))];
      if (cand[0].t > ts) { cand = list.find(([s]) => s.t <= ts); if (!cand) continue; }
      if (items.some((x) => x[0] === cand[1])) continue;
      const layer = weighted(R, [0.035, 0.895, 0.07]);
      items.push([cand[1], layer]);
      if (R() < 0.005) tr(cand[1], ts, 0.3 + R() * 0.3, 0.5 + R() * 0.4, layer === 2 ? 4 : 2);
    }
    const rawN = R() < 0.3 ? 0 : Math.floor(R() * 6);
    if (!items.length && !rawN) continue;
    recalls.push([ts, place, items, rawN]);
  }
  recalls.sort((a, b) => a[0] - b[0]);
  // ── 说起（told_log）：讲给别人，常常是在别的场合 ──
  const tells = [];
  const nTell = big ? 8000 : 5200;
  for (let r = 0; r < nTell; r++) {
    const at = pickTime(R, start + 6 * HOUR, now - MIN, 0.7);
    const place = weighted(R, [0.25, 0.3, 0.25, 0.17, 0.03]);
    let born = 0; for (let lo = 0, hi = stars.length; lo < hi;) { const mid = (lo + hi) >> 1; if (stars[mid].t <= at) lo = born = mid + 1; else hi = mid; }
    if (!born) continue;
    const i = Math.floor(Math.pow(R(), 0.5) * born);
    if (stars[i].k === 3) continue;
    tells.push([at, place, i, R() < 0.55 ? 1 : 0]);
    if (R() < 0.075) tr(i, at, 0.6, 0.5, 6);
  }
  tells.sort((a, b) => a[0] - b[0]);
  traces.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  // ── 心境：醒着的时候每 20 分钟一个点，效价慢慢漂 ──
  const mood = [];
  let v = 0.2; let inten = 0.35;
  for (let t = start; t <= now && mood.length < 2000; t += 20 * MIN) {
    if (ACTIVITY[bjHour(t)] < 0.1) continue;
    v = Math.max(-1, Math.min(1, v * 0.96 + (R() - 0.47) * 0.22));
    inten = Math.max(0.05, Math.min(1, inten * 0.9 + 0.04 + R() * 0.08 + Math.abs(v) * 0.03));
    mood.push([t, Math.round(v * 100) / 100, Math.round(inten * 100) / 100]);
  }
  // ── 听到的话：按（场合，整点）计数 ──
  const heard = [];
  const placeRate = [6, 14, 26, 9, 2];
  let percepts = 0;
  for (let h = Math.floor(start / HOUR) * HOUR; h <= now; h += HOUR) {
    const a = ACTIVITY[bjHour(h)];
    for (let p = 0; p < NP; p++) {
      const n = poisson(R, a * placeRate[p] * (0.5 + R()));
      if (!n) continue;
      const toHer = p === 0 || p === 4 ? Math.round(n * (0.7 + R() * 0.3)) : Math.round(n * R() * 0.25);
      heard.push([p, h, n, toHer]);
      percepts += n;
    }
  }

  const people = persons.map((p, i) => ({ ...p, n: stars.filter((s) => s.who[0] === i).length }));
  // 只列至少是一颗星的 who 的人（和她自己）
  const used = new Set(stars.flatMap((s) => s.who));
  const keep = people.map((p, i) => i === 0 || used.has(i));
  const remap = []; let c = 0;
  keep.forEach((k, i) => { remap[i] = k ? c++ : -1; });
  const peopleOut = people.filter((_, i) => keep[i]);
  const rows = stars.map((s) => [s.ref, s.k, s.sub, s.t, s.t2, s.place, s.who.map((w) => remap[w]).filter((w) => w >= 0), s.st, s.sup, s.imp, s.cert, s.val, s.b]);
  const t0 = Math.min(stars[0].t, heard.length ? heard[0][1] : Infinity);
  const counts = { percepts, episode: stars.filter((s) => s.k === 0).length, fact: stars.filter((s) => s.k === 1).length, plan: stars.filter((s) => s.k === 2).length, lesson: stars.filter((s) => s.k === 3).length };
  // 场合按星数降序（核心的顺序），星和想起、说起、听到的话里的下标跟着换
  const placeN = PLACES.map((_, p) => stars.filter((s) => s.place === p).length);
  const porder = PLACES.map((_, p) => p).sort((a, b) => placeN[b] - placeN[a]);
  const pnew = []; porder.forEach((old, k) => { pnew[old] = k; });
  const places = porder.map((old) => ({ ...PLACES[old], n: placeN[old] }));
  for (const r of rows) r[5] = r[5] < 0 ? -1 : pnew[r[5]];
  for (const r of recalls) r[1] = pnew[r[1]];
  for (const r of tells) r[1] = pnew[r[1]];
  for (const r of heard) r[0] = pnew[r[0]];
  heard.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const base = { traces, recalls, tells };
  const rev = `${na + 100}.${ne}.${nt}.0.${Math.max(...stars.map((s) => s.t))}`;

  // ── 内容（看一眼）──
  const nameOf = (s) => (s.who.length ? persons[s.who[s.who.length > 1 && s.who[0] === 0 ? 1 : 0]].name : '有人');
  const fill = (tpl, s) => tpl.replaceAll('{n}', nameOf(s));
  const textOf = (s, i) => {
    const R2 = rng(seed * 31 + i);
    if (i % 97 === 13) return { title: s.k === 0 ? '搬家的事' : null, text: fill(LONG, s) };
    if (s.k === 0) { const title = fill(pick(R2, EPISODES), s); return { title, text: `${title}。${pick(R2, ['后来大家又聊了一会儿别的。', '她记得那天挺开心的。', '说到一半有人插进来问别的事。', ''])}`.trim() }; }
    if (s.intention) return { title: null, text: fill(pick(R2, INTENTS), s) };
    if (s.k === 2) return { title: null, text: fill(pick(R2, PLANS), s) };
    if (s.k === 3) return { title: null, text: pick(R2, LESSONS) };
    if (s.hi === 0) return { title: null, text: pick(R2, SELF_FACTS) };
    return { title: null, text: fill(pick(R2, FACTS), s) };
  };
  const refIdx = new Map(stars.map((s, i) => [s.ref, i]));

  // ── 实时：每次增量调用都生成一两条新的想起（偶尔一条说起），id 接在快照的游标后面 ──
  const liveRows = { traces: [], recalls: [], tells: [] };
  let liveCalls = 0;
  function grow(at) {
    const LR = rng(seed * 7 + ++liveCalls);
    // 真实库里大约十几分钟才想起一次；这里放快一些（平均几秒一条），预览里「此刻」才看得到，但不至于满屏是线
    const n = LR() < 0.45 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const place = weighted(LR, [0.3, 0.25, 0.2, 0.15, 0.1]);
      const items = [];
      const m = 1 + Math.floor(LR() * 3);
      for (let j = 0; j < m; j++) {
        const i = Math.floor(Math.pow(LR(), 0.35) * stars.length);
        if (items.some((x) => x[0] === stars[i].ref)) continue;
        const layer = weighted(LR, [0.15, 0.65, 0.2]);
        items.push([stars[i].ref, layer]);
        liveRows.traces.push([stars[i].ref, at - (n - 1 - k) * 400, 0.45, 0.6, layer === 2 ? 4 : 2]);
      }
      liveRows.recalls.push([at - (n - 1 - k) * 400, places[place].key, items, Math.floor(LR() * 3)]);
    }
    if (LR() < 0.2) {
      const i = Math.floor(Math.pow(LR(), 0.4) * stars.length);
      liveRows.tells.push([at, places[weighted(LR, [0.4, 0.25, 0.15, 0.1, 0.1])].key, stars[i].ref, LR() < 0.5 ? 1 : 0]);
      liveRows.traces.push([stars[i].ref, at, 0.6, 0.5, 6]);
    }
  }

  return {
    stars: N,
    snapshot(at = now) {
      return {
        now: at, rev, cursor: { inj: recalls.length, trace: traces.length, told: tells.length },
        params: { ageFloorMs: 180_000, timeUnitMs: HOUR }, t0,
        people: peopleOut, places,
        stars: { cols: [...COLS], rows: rows.map((r) => [...r.slice(0, 6), [...r[6]], ...r.slice(7)]) },
        traces: base.traces, recalls: base.recalls, tells: base.tells, mood, heard, nights,
        dropped: 0, counts,
      };
    },
    /** since = {inj, trace, told}；at = 这一刻。每样最多 500 行，取最早的。 */
    live(since, at = now) {
      grow(at);
      const slice = (list, from, baseN) => list.slice(Math.max(0, from - baseN), Math.max(0, from - baseN) + 500);
      const tr2 = slice(liveRows.traces, since.trace, traces.length);
      const rc = slice(liveRows.recalls, since.inj, recalls.length);
      const tl = slice(liveRows.tells, since.told, tells.length);
      return {
        now: at, rev,
        cursor: { inj: Math.max(since.inj, recalls.length) + rc.length, trace: Math.max(since.trace, traces.length) + tr2.length, told: Math.max(since.told, tells.length) + tl.length },
        traces: tr2, recalls: rc, tells: tl,
      };
    },
    peek(refs) {
      return { items: refs.filter((r) => refIdx.has(r)).map((ref) => { const i = refIdx.get(ref); const s = stars[i]; const x = textOf(s, i); return { ref, title: x.title, text: x.text, at: s.t }; }) };
    },
  };
}
