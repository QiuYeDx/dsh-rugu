// DSH 插件测试的替身。宿主上下文：FakeDshCtx；核心 API：createFakePm；临时目录一律在仓库的 .tmp/ 下（C 盘快满了）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { FakeDshCtx, FakePresetRegistry, FAKE_STANDARD_ROWS, fakeAgent, userMessage } from './fake-dsh-ctx.js';
export { createFakePm } from './fake-pm.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const TMP_ROOT = path.join(REPO_ROOT, '.tmp');

/** 新建一个空的临时目录（在 .tmp 下）。 */
export function tmpDir(name) {
  const dir = path.join(TMP_ROOT, `dsh-${name}-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 只删 .tmp 下的目录。 */
export function rmDir(dir) {
  if (!dir || !path.resolve(dir).startsWith(TMP_ROOT)) throw new Error(`只删 .tmp 下的目录：${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * 一个假的 DSH 绑定（§4.6）：preset 'zz-chat' 的会话认领成 specific；工具全分类。
 * @param {object} [o]
 */
export function fakeBinding(o = {}) {
  const adapterId = o.adapterId ?? 'zz';
  const settingId = o.settingId ?? 'set-zz-1';
  return {
    adapterId,
    claimSession: o.claimSession ?? ((s) => (s.preset === (o.preset ?? 'zz-chat') ? { settingId, confidence: o.confidence ?? 'specific' } : null)),
    sessionSignature: o.sessionSignature ?? (() => ({ presets: [o.preset ?? 'zz-chat'] })),
    ...(o.fromSessionEvent !== undefined ? { fromSessionEvent: o.fromSessionEvent } : {
      fromSessionEvent: (ev, setting, sessionId) => {
        if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
          const text = ev.data.content?.[0]?.text ?? '';
          return [{ id: `obs-${ev.data.id}`, settingId: setting, visibleTo: 'setting-audience', at: Date.now(), perceivedAt: Date.now(), actor: { claims: [{ kind: 'account', namespace: adapterId, id: 'u1', verifiedBy: 'platform' }] },
            kind: 'utterance', text, addressed: 'to-her', attention: 'attended', evidential: true, standing: 'first-hand', sessionRef: { sessionId } }];
        }
        if (ev.type === 'tool/result' && ev.data?.name === `${adapterId}_read`) {
          return [{ id: `obs-tool-${ev.data.callId}`, settingId: setting, visibleTo: 'setting-audience', at: Date.now(), perceivedAt: Date.now(), actor: { claims: [] },
            kind: 'utterance', text: 'from tool', addressed: 'ambient', attention: 'attended', evidential: true, standing: 'first-hand' }];
        }
        return [];
      },
    }),
    ...(o.resolveFocus !== undefined ? { resolveFocus: o.resolveFocus } : { resolveFocus: (m) => (m?.id ? `obs-${m.id}` : null) }),
    tools: o.tools ?? [
      { tool: `${adapterId}_send`, class: 'speak', resolve: (args) => (args?.text ? { channel: { targetSettingId: args.target ?? settingId, persistence: 'once' }, text: [String(args.text)], origin: { path: 'tool' } } : null) },
      { tool: `${adapterId}_rule`, class: 'standing', resolve: (args) => ({ channel: { targetSettingId: settingId, persistence: 'recurring-context' }, text: [String(args?.text ?? '')], origin: { path: 'tool' } }) },
      { tool: `${adapterId}_post`, class: 'speak', appraisedBy: 'adapter' },
      { tool: `${adapterId}_read`, class: 'read', readerKind: 'content' },
      { tool: `${adapterId}_ping`, class: 'none' },
    ],
    ...(o.extra ?? {}),
  };
}
