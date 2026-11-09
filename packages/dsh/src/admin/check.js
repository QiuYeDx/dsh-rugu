// 管理接口的输入校验（§13.1）：页面传来的每个字段先在这里过一遍，不合格的直接 400，不往核心里送。
// 核心自己也会校验（ContractError）；这里先挡一层，是为了给主人看得懂的错误，并且不把奇怪的形状送进核心。
// 记忆引用、场合键、空间 id 对集成层是不透明的：这里只查「是不是一个安全的短字符串」，不解析它们的格式。

/** 输入不合格。path 指出哪个字段，message 是给人看的中文。 */
export class InputError extends Error {
  /** @param {string} path @param {string} message */
  constructor(path, message) {
    super(`${path}：${message}`);
    this.name = 'InputError';
    this.code = 'BAD_INPUT';
    this.path = path;
  }
}

const OPAQUE_RE = /^[A-Za-z0-9_\-:.=+/]{1,128}$/;

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** 正整数（也认十进制数字字符串，表单传来的就是字符串）。 */
export function posInt(v, path) {
  const n = typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n <= 0) throw new InputError(path, '应为正整数');
  return n;
}

/** 非负整数（成长块回到第 0 版 = 空）。 */
export function nonNegInt(v, path) {
  const n = typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 0) throw new InputError(path, '应为非负整数');
  return n;
}

/** 时间（UTC 毫秒），限在 2000 年到 2200 年之间，挡掉明显的误填。 */
export function timeMs(v, path) {
  const n = typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 946_684_800_000 || n > 7_258_118_400_000) throw new InputError(path, '应为时间（毫秒）');
  return n;
}

/** 核心给的不透明字符串（记忆引用、场合键、向量空间 id）：只查长度和字符集。 */
export function opaque(v, path) {
  if (typeof v !== 'string' || !OPAQUE_RE.test(v)) throw new InputError(path, '格式不对');
  return v;
}

/** 枚举。 */
export function oneOf(v, options, path) {
  if (!options.includes(v)) throw new InputError(path, `应为 ${options.join(' / ')} 之一`);
  return v;
}

export function bool(v, path, dflt = false) {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') throw new InputError(path, '应为 true / false');
  return v;
}

/**
 * 有长度上限的文本（规则备注、信息类型、恢复码……）。长度按字符数（码点）算。
 * normalize=false：不做 NFKC（名字这类主人要原样看到的字：NFKC 会把全角字母、带圈数字这些悄悄改掉）。
 */
export function text(v, path, { max = 200, min = 1, optional = false, normalize = true } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (typeof v !== 'string') throw new InputError(path, '应为文字');
  const s = (normalize ? v.normalize('NFKC') : v).trim();
  if ([...s].length < min) throw new InputError(path, '不能为空');
  if ([...s].length > max) throw new InputError(path, `太长了（最多 ${max} 字）`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new InputError(path, '含有控制字符');
  return s;
}

/** 列表：每一项过 item 校验，去重，限长度。 */
export function list(v, path, item, { max = 50, min = 1 } = {}) {
  if (!Array.isArray(v)) throw new InputError(path, '应为列表');
  if (v.length < min) throw new InputError(path, '不能为空');
  if (v.length > max) throw new InputError(path, `一次最多 ${max} 项`);
  return [...new Set(v.map((x, i) => item(x, `${path}[${i}]`)))];
}

/**
 * Windows / POSIX 的绝对路径（异地备份目录）。只做形状检查，不碰磁盘；空串 = 不设置。
 * 不收相对路径、UNC 以外的奇怪前缀、`..` 段和控制字符。
 */
export function absDir(v, path) {
  if (v === '' ) return '';
  if (typeof v !== 'string') throw new InputError(path, '应为文件夹路径');
  const s = v.trim();
  if (s.length > 260) throw new InputError(path, '路径太长');
  if (/[\u0000-\u001f"<>|?*]/.test(s.replace(/^[A-Za-z]:/, ''))) throw new InputError(path, '路径里有不能用的字符');
  const win = /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(s);
  const posix = s.startsWith('/');
  if (!win && !posix) throw new InputError(path, '要写完整的绝对路径（例如 D:\\备份\\记忆）');
  if (s.split(/[\\/]+/).some((seg) => seg === '..')) throw new InputError(path, '路径里不能有 ..');
  if (/^[A-Za-z]:[\\/]?$/.test(s) || s === '/') throw new InputError(path, '不能直接用盘符根目录');
  return s;
}

/** 请求体里只许出现这些键（多出来的直接拒绝，免得拼写错误被悄悄忽略）。 */
export function onlyKeys(obj, keys, path = 'body') {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new InputError(`${path}.${k}`, '不认识的字段');
  return obj;
}

/** 确认语的比较：NFKC、去首尾空白、折叠中间的空白。 */
export function samePhrase(a, b) {
  const n = (s) => String(s ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  return typeof a === 'string' && typeof b === 'string' && n(a) !== '' && n(a) === n(b);
}

/**
 * 只留数字和短状态（§13.3「只有数字，没有内容」）：宿主状态、预算、显卡这些对象原样转给页面之前过一遍。
 * 字符串截到 160 字，数组最多 64 项，深度 5；函数、Symbol 丢掉。宿主本来就不该放内容进来，这里是保险。
 * @param {unknown} v
 * @returns {unknown}
 */
export function numbersOnly(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return v.length > 160 ? `${v.slice(0, 160)}…` : v;
  if (depth >= 5) return null;
  if (Array.isArray(v)) return v.slice(0, 64).map((x) => numbersOnly(x, depth + 1));
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 80)) {
      if (typeof x === 'function' || typeof x === 'symbol' || x === undefined) continue;
      out[k] = numbersOnly(x, depth + 1);
    }
    return out;
  }
  return null;
}
