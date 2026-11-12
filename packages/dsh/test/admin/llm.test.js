// 管理页的后台模型（D168）：llm.list / llm.test / llm.save 的参数校验、只给主人、设置模式下也能用；llmSetup 视图；总览的提醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ORIGIN, TOKEN } from './helpers.js';
import { makeFakeHost } from './fixtures.js';
import { createAdminHandlers, ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { llmHealthRow } from '../../src/admin/views.js';

const PAIR = { provider: 'deepseek-account', model: 'deepseek-flash' };
/** 假的 host.llmSetup：记调用，状态可改。 */
function hostWithLlm(state = { state: 'ok', mode: 'chosen', pairs: [{ use: 'extract', pair: PAIR, state: 'ok', lastOkAt: 1 }], fallbackToChat: true, waiting: false }) {
  const host = makeFakeHost();
  const calls = [];
  const st = { ...state };
  host.llmSetup = {
    list: async () => { calls.push(['list']); return { available: true, providers: [{ id: 'deepseek-account', name: 'DeepSeek Account', models: [{ id: 'deepseek-flash', name: 'flash' }] }], current: { target: null, perUse: {}, effective: PAIR }, suggest: { ...PAIR, why: 'deepseek' } }; },
    test: async (p) => { calls.push(['test', p]); return { ok: true, level: 'ok', verdict: '能用，第一眼 0.9 秒，提炼 7.0 秒', pair: p ?? PAIR, steps: {} }; },
    save: (p) => { calls.push(['save', p]); return { ok: true, warnings: [] }; },
    status: () => st,
    summary: () => ({ plugin: '0.0.0', providerKind: 'deepseek-account', model: 'deepseek-flash', errors24h: {} }),
  };
  return { host, calls, st };
}

test('llm.list / llm.test / llm.save：参数校验（多出来的字段、坏的一对都拒绝），校验过了才交给宿主', async () => {
  const { host, calls } = hostWithLlm();
  const s = setup({ host });
  assert.equal((await s.act('llm.list')).body.result.suggest.model, 'deepseek-flash');
  assert.equal((await s.act('llm.list', { x: 1 })).body.code, 'BAD_INPUT');
  // 不给一对 = 试现在选的；给就要两个都给
  assert.equal((await s.act('llm.test')).body.result.ok, true);
  assert.deepEqual(calls.at(-1), ['test', null]);
  await s.act('llm.test', { provider: 'p', model: 'm' });
  assert.deepEqual(calls.at(-1), ['test', { provider: 'p', model: 'm' }]);
  assert.equal((await s.act('llm.test', { provider: 'p' })).body.code, 'BAD_INPUT');
  assert.equal((await s.act('llm.test', { provider: 'p', model: 'm\u0001' })).body.code, 'BAD_INPUT', '控制字符');
  // 保存：一对 / off / 高级里的单独一对（null = 跟着）/ 顶上的开关
  await s.act('llm.save', { target: PAIR });
  assert.deepEqual(calls.at(-1), ['save', { target: PAIR }]);
  await s.act('llm.save', { target: 'off' });
  assert.deepEqual(calls.at(-1), ['save', { target: 'off' }]);
  await s.act('llm.save', { perUse: { glance: PAIR, extract: null }, fallbackToChat: false });
  assert.deepEqual(calls.at(-1), ['save', { perUse: { glance: PAIR, extract: null }, fallbackToChat: false }]);
  const n = calls.length;
  for (const bad of [{}, { target: 'on' }, { target: { provider: 'p' } }, { target: { ...PAIR, why: 'x' } }, { perUse: { review: PAIR } }, { fallbackToChat: 'yes' }, { other: 1 }]) {
    assert.equal((await s.act('llm.save', bad)).body.code, 'BAD_INPUT', JSON.stringify(bad));
  }
  assert.equal(calls.length, n, '校验没过的一次都没交给宿主');
  // 宿主没有这一块：不可用，不崩
  const plainHost = makeFakeHost();
  delete plainHost.llmSetup;
  const plain = setup({ host: plainHost });
  assert.equal((await plain.act('llm.list')).status >= 400, true);
});

test('只给主人：没有令牌的请求不让列、不让试、不让存', async () => {
  const { host, calls } = hostWithLlm();
  const s = setup({ host });
  const r = await s.act('llm.save', { target: PAIR }, { [TOKEN_HEADER]: 'wrong' });
  assert.ok(r.status === 401 || r.status === 403);
  assert.equal(calls.length, 0);
});

test('首次设置模式（还没有核心）：后台模型的三个操作和 llmSetup 视图也能用', async () => {
  const { host, calls } = hostWithLlm();
  const h = createAdminHandlers({ pm: null, host, log: { info() {}, warn() {}, error() {} }, now: () => 0, token: TOKEN, setupMode: true });
  const headers = { [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  for (const action of ['llm.list', 'llm.test', 'llm.save']) {
    const body = action === 'llm.save' ? { action, target: PAIR } : { action };
    const res = await h.act(new Request(`${ORIGIN}${ROUTES.act}`, { method: 'POST', headers, body: JSON.stringify(body) }));
    assert.equal(res.status, 200, action);
  }
  assert.equal(calls.length, 3);
  const v = await h.data(new Request(`${ORIGIN}${ROUTES.data}?view=llmSetup`, { headers }));
  assert.equal(v.status, 200);
  assert.equal((await v.json()).data.status.state, 'ok');
});

test('总览的提醒：不工作（红，说从几点起、为什么、去哪儿）/ 在用聊天模型顶着（黄，可能更贵）/ 不稳定 / 不用 / 正在补积压', async () => {
  const down = hostWithLlm({ state: 'down', mode: 'chosen', code: 'UNKNOWN_MODEL', since: Date.UTC(2026, 10, 13, 6, 20), pair: { provider: 'my-openai', model: 'deepseek-flash' }, pairs: [], fallbackToChat: false });
  let a = (await setup({ host: down.host }).view('overview')).body.data.alerts.find((x) => /后台模型/.test(x.text));
  assert.equal(a.level, 'bad');
  assert.match(a.text, /后台模型从 \d\d:\d\d 起不工作（连不上：「my-openai」没有叫 deepseek-flash 的模型）。这段时间她记不住新的事、回想变少，聊天照常/);
  assert.match(a.text, /「设置 → 后台模型」/);
  assert.equal(a.tab, 'config');
  const fb = hostWithLlm({ state: 'down', mode: 'chosen', code: 'AUTH', pair: PAIR, fallback: { provider: 'deepseek-account', model: 'deepseek-v4-pro', since: 1 }, pairs: [] });
  a = (await setup({ host: fb.host }).view('overview')).body.data.alerts.find((x) => /后台模型/.test(x.text));
  assert.equal(a.level, 'warn');
  assert.match(a.text, /临时在用你聊天的模型（deepseek-account \/ deepseek-v4-pro），可能更贵/);
  const flaky = hostWithLlm({ state: 'flaky', code: 'TIMEOUT', pairs: [] });
  assert.ok((await setup({ host: flaky.host }).view('overview')).body.data.alerts.some((x) => x.level === 'warn' && /不稳定/.test(x.text)));
  const off = hostWithLlm({ state: 'off', pairs: [] });
  assert.ok((await setup({ host: off.host }).view('overview')).body.data.alerts.some((x) => x.level === 'info' && /不用后台模型/.test(x.text)));
  const catchUp = hostWithLlm({ state: 'ok', pairs: [], catchUp: 7 });
  assert.ok((await setup({ host: catchUp.host }).view('overview')).body.data.alerts.some((x) => /正在补之前没整理的 7 段/.test(x.text)));
  const ok = hostWithLlm();
  assert.ok(!(await setup({ host: ok.host }).view('overview')).body.data.alerts.some((x) => /后台模型/.test(x.text)), '正常时不提醒');
});

test('llmHealthRow：只留服务商 id、模型名、错误码、时间和数字，错误码配一句人话', () => {
  const r = llmHealthRow({ state: 'down', code: 'MISSING_CREDENTIAL', since: 5, pair: { provider: 'p', model: 'm', secret: 'x' }, pairs: [{ use: 'extract', pair: { provider: 'p', model: 'm' }, state: 'down', byCode: { MISSING_CREDENTIAL: 2, bad: 'x' } }], junk: 1 });
  assert.equal(r.reason, '连不上：「p」还没登录或者没填 Key（在 DSH 的模型设置里补上）');
  assert.deepEqual(r.pair, { provider: 'p', model: 'm' });
  assert.deepEqual(r.pairs[0].byCode, { MISSING_CREDENTIAL: 2 });
  assert.equal('junk' in r, false);
  assert.equal(llmHealthRow(null), null);
});
