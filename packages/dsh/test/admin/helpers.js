// 管理页测试的小工具：用假 pm / 假 host 建一套处理函数，按 HTTP 的样子发请求、走确认令牌。
import { createAdminHandlers, ROUTES, TOKEN_HEADER } from '../../src/admin/index.js';
import { makeFakePm, makeFakeHost, NOW } from './fixtures.js';

export const TOKEN = 'test-admin-token';
export const ORIGIN = 'http://127.0.0.1:41234';

/**
 * @param {{scenario?: 'normal'|'empty'|'errors', exportDir?: string|null|(() => string|null), pm?: any, host?: any}} [o]
 */
export function setup(o = {}) {
  const scenario = o.scenario ?? 'normal';
  const pm = o.pm ?? makeFakePm({ scenario });
  const host = o.host === undefined ? makeFakeHost({ scenario }) : o.host;
  const clock = { t: NOW };
  const logs = [];
  const log = {
    info: (ev, f) => logs.push(['info', ev, f]),
    warn: (ev, f) => logs.push(['warn', ev, f]),
    error: (ev, f) => logs.push(['error', ev, f]),
  };
  const h = createAdminHandlers({ pm, host, log, now: () => clock.t, token: TOKEN, exportDir: o.exportDir ?? null });
  const headers = (extra = {}) => ({ [TOKEN_HEADER]: TOKEN, 'sec-fetch-site': 'same-origin', ...extra });

  /** POST 一个操作；返回 {status, body}。 */
  async function act(action, body = {}, extraHeaders = {}) {
    const res = await h.act(new Request(`${ORIGIN}${ROUTES.act}`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json', ...extraHeaders }), body: JSON.stringify({ action, ...body }),
    }));
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  /** GET 一个视图。 */
  async function view(name, q = {}, extraHeaders = {}) {
    const qs = new URLSearchParams({ view: name, ...q }).toString();
    const res = await h.data(new Request(`${ORIGIN}${ROUTES.data}?${qs}`, { headers: headers(extraHeaders) }));
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  /** prepare → 令牌（和确认语、预览）。 */
  async function prepare(action, params) {
    const r = await act('prepare', { for: action, params });
    if (r.status !== 200) throw new Error(`prepare ${action} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.result;
  }
  /** 走完整的确认流程：prepare，然后带令牌和确认语（不给 typed 就照令牌给的确认语输入）提交。 */
  async function confirmAct(action, params, typed) {
    const pr = await prepare(action, params);
    const confirm = { token: pr.token, ...(pr.phrase ? { typed: typed ?? pr.phrase } : {}) };
    return { pr, ...(await act(action, { ...params, confirm })) };
  }
  const callsOf = (name) => pm.calls.filter((c) => c.name === name);
  const hostCallsOf = (name) => host.calls.filter((c) => c.name === name);
  return { pm, host, h, clock, logs, act, view, prepare, confirmAct, callsOf, hostCallsOf, headers };
}
