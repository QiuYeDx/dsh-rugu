// 「设置」和首次设置向导的写操作（D173）。形状和 actions.js 一样（parse / needsConfirm / prepare / bind / run），由 actions.js 合进同一张表。
//   persona.save           她是谁：她怎么称呼你、她的名字和昵称、DSH 新建任务里的预设名、人设开头 → 宿主配置 host.self / host.adapters.qq / host.preset
//   qq.selfAccount         她自己的 QQ 账号 → host.adapters.qq.selfAccount（空 = 让插件自己认）
//   discretion.onFailure   说话前的细看没成的时候怎么办（D169）→ 核心配置 discretion.stage2.onFailure
//   setup.draft            首次设置的草稿（只在设置模式下）→ host.setup.draft（写配置时宿主自动标成「向导写了一半」，不会被当成设置完了）
// 都是热加载：写进配置文件马上生效（预设名、人设开头由预设服务重新注册，见 preset/index.js）。
// 日志只记操作名（handlers.js），名字、人设开头这些文字不进日志。
import { InputError, isPlainObject, onlyKeys, oneOf, text, list, bool } from './check.js';

/** 和 preset/index.js、scripts/preset-config.mjs 一致。 */
export const PREFIX_MAX = 2000;
/** 设置模式（还没有核心）下也能用的写操作。 */
export const SETUP_MODE_ACTIONS = Object.freeze(['setup.draft']);
/** 像个 QQ 号：纯数字、5 到 12 位、不以 0 开头（和 adapters/qq/names.js 认账号的规矩一致）。 */
const QQ_ACCOUNT = /^[1-9]\d{4,11}$/;

const nameList = (v, path) => {
  if (v === '' || v == null) return [];
  // 页面可以直接给一串（逗号、顿号、空格隔开），也可以给列表
  const arr = typeof v === 'string' ? v.split(/[,，、;；\s]+/).filter(Boolean) : v;
  return list(arr, path, (x, p) => text(x, p, { max: 30, normalize: false }), { max: 16, min: 0 });
};
/** 可以清空的一段文字：'' / null = 清掉（用默认），其余照 text 校验。 */
const clearable = (v, path, max, { normalize = false } = {}) => (v === '' || v === null ? '' : text(v, path, { max, normalize }));
/** 人设开头：一段话，可以换行；控制字符里只许换行和制表符。 */
function prefixText(v, path) {
  if (v === '' || v === null) return '';
  if (typeof v !== 'string') throw new InputError(path, '应为文字');
  const s = v.replace(/\r\n?/g, '\n').trim();
  if ([...s].length > PREFIX_MAX) throw new InputError(path, `太长了（最多 ${PREFIX_MAX} 字）`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new InputError(path, '含有控制字符');
  return s;
}

/**
 * @param {{host: any, setConfig: (patch: object, confirmed: any, extra?: object) => Promise<any>, warningsOf: (r: any) => string[], unavailable: (what: string) => Error}} d
 */
export function createSettingsActions(d) {
  const { host, setConfig, warningsOf, unavailable } = d;
  const hostPart = (k) => (host && typeof host === 'object' ? host[k] : undefined);
  /** 配置文件读不了（坏了）时不往里写：给一句看得懂的话，不覆盖主人的文件。 */
  const ensureWritable = () => {
    const cfg = hostPart('config');
    if (typeof cfg?.set !== 'function') throw unavailable('配置');
    let loadError = null;
    try { const c = cfg.get?.(); loadError = c?.meta?.loadError ?? c?.loadError ?? null; } catch { loadError = null; }
    if (loadError) throw Object.assign(new Error(`配置文件读不了（${String(loadError).slice(0, 40)}），先修好它再在这里改`), { code: 'CONFIG_WRITE' });
  };

  return {
    'persona.save': {
      parse: (b) => {
        onlyKeys(b, ['action', 'principalLabel', 'selfNames', 'presetName', 'personaPrefix']);
        const p = {};
        if (b.principalLabel !== undefined) p.principalLabel = clearable(b.principalLabel, 'principalLabel', 20);
        if (b.selfNames !== undefined) p.selfNames = nameList(b.selfNames, 'selfNames');
        if (b.presetName !== undefined) p.presetName = clearable(b.presetName, 'presetName', 40);
        if (b.personaPrefix !== undefined) p.personaPrefix = prefixText(b.personaPrefix, 'personaPrefix');
        if (!Object.keys(p).length) throw new InputError('body', '至少要改一项');
        return p;
      },
      run: async (p) => {
        ensureWritable();
        const h = {};
        if (p.principalLabel !== undefined) h.self = { principalLabel: p.principalLabel };
        if (p.selfNames !== undefined) h.adapters = { qq: { selfNames: p.selfNames } };
        if (p.presetName !== undefined || p.personaPrefix !== undefined) {
          h.preset = {};
          if (p.presetName !== undefined) h.preset.name = p.presetName;
          if (p.personaPrefix !== undefined) h.preset.personaPrefix = p.personaPrefix;
        }
        // 名字列表是数组：配置合并时整个换掉（删掉的名字真的删掉）
        const r = await setConfig({ host: h }, null);
        return { saved: Object.keys(p), warnings: warningsOf(r) };
      },
    },

    'qq.selfAccount': {
      parse: (b) => {
        onlyKeys(b, ['action', 'account']);
        const a = typeof b.account === 'string' ? b.account.trim() : b.account;
        if (a === '' || a === null) return { account: '' };
        if (typeof a !== 'string' || !QQ_ACCOUNT.test(a)) throw new InputError('account', '应为 5–12 位数字的 QQ 号（不以 0 开头）');
        return { account: a };
      },
      run: async (p) => {
        ensureWritable();
        const r = await setConfig({ host: { adapters: { qq: { selfAccount: p.account } } } }, null);
        return { account: p.account, warnings: warningsOf(r) };
      },
    },

    'discretion.onFailure': {
      parse: (b) => (onlyKeys(b, ['action', 'value']), { value: oneOf(b.value, ['give', 'omit'], 'value') }),
      run: async (p) => {
        ensureWritable();
        const r = await setConfig({ discretion: { stage2: { onFailure: p.value } } }, null);
        return { value: p.value, warnings: warningsOf(r) };
      },
    },

    'setup.draft': {
      parse: (b) => {
        onlyKeys(b, ['action', 'draft']);
        const v = b.draft;
        if (!isPlainObject(v)) throw new InputError('draft', '应为对象');
        onlyKeys(v, ['step', 'ack', 'principalLabel', 'selfNames', 'presetName', 'personaPrefix', 'embed', 'offGroups', 'selfAccount', 'llmSkipped'], 'draft');
        const out = {};
        if (v.step !== undefined) {
          if (!Number.isInteger(v.step) || v.step < 1 || v.step > 5) throw new InputError('draft.step', '应为 1–5');
          out.step = v.step;
        }
        if (v.ack !== undefined) out.ack = bool(v.ack, 'draft.ack');
        if (v.llmSkipped !== undefined) out.llmSkipped = bool(v.llmSkipped, 'draft.llmSkipped');
        if (v.principalLabel !== undefined) out.principalLabel = clearable(v.principalLabel, 'draft.principalLabel', 20);
        if (v.selfNames !== undefined) out.selfNames = nameList(v.selfNames, 'draft.selfNames');
        if (v.presetName !== undefined) out.presetName = clearable(v.presetName, 'draft.presetName', 40);
        if (v.personaPrefix !== undefined) out.personaPrefix = prefixText(v.personaPrefix, 'draft.personaPrefix');
        if (v.embed !== undefined) out.embed = oneOf(v.embed, ['none', 'ollama', 'external'], 'draft.embed');
        if (v.offGroups !== undefined) {
          const groupId = (x, p) => { if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(x)) throw new InputError(p, '群号不对'); return x; };
          out.offGroups = list(v.offGroups, 'draft.offGroups', groupId, { max: 500, min: 0 });
        }
        if (v.selfAccount !== undefined) {
          const a = typeof v.selfAccount === 'string' ? v.selfAccount.trim() : v.selfAccount;
          if (a === '' || a === null) out.selfAccount = '';
          else if (typeof a !== 'string' || !QQ_ACCOUNT.test(a)) throw new InputError('draft.selfAccount', '应为 5–12 位数字的 QQ 号（不以 0 开头）');
          else out.selfAccount = a;
        }
        return { draft: out };
      },
      run: (p) => {
        const s = hostPart('setup');
        if (typeof s?.saveDraft !== 'function') throw unavailable('首次设置的草稿');
        // 已经设置过了：草稿没有用处，也不该再写进配置（宿主那边同样会拒）
        if (s.status?.()?.needed !== true) throw Object.assign(new Error('已经设置过了，不用再存首次设置的草稿'), { code: 'REJECTED' });
        return s.saveDraft(p.draft);
      },
    },
  };
}
