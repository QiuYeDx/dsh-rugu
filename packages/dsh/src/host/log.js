// Logger 端口（§3.3、§12.3）：只记事件名、id、类型和计数，**不记内容**。字段值只收数字、布尔和短字符串。
// 同时留一个最近错误的小环（只有事件名和错误类型），给管理页总览「最近的错误（只有 id）」（§13.1）。

const MAX_STR = 80;

/** 只留安全的字段：数字、布尔、null、短字符串（截到 80 字，去换行）。 */
export function safeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    else if (typeof v === 'string') out[k] = v.replace(/[\r\n]+/g, ' ').slice(0, MAX_STR);
  }
  return out;
}

const fmt = (event, fields) => {
  const f = Object.entries(safeFields(fields)).map(([k, v]) => `${k}=${v}`).join(' ');
  return `[persona-memory] ${event}${f ? ` ${f}` : ''}`;
};

/**
 * @param {{logger?: {debug?: Function, info?: Function, warn?: Function, error?: Function}}|null} ctx
 * @param {{now?: () => number, ring?: number, debug?: boolean}} [opt]
 */
export function createLogger(ctx, { now = () => Date.now(), ring = 50, debug = false } = {}) {
  const recent = [];
  const counts = new Map();
  const sink = (level, event, fields) => {
    try {
      const l = ctx?.logger;
      const fn = l?.[level] ?? (level === 'debug' ? null : l?.info);
      if (fn && (level !== 'debug' || debug)) fn.call(l, fmt(event, fields));
    } catch { /* 日志也失败就算了 */ }
  };
  const note = (level, event, fields) => {
    counts.set(level, (counts.get(level) ?? 0) + 1);
    if (level === 'warn' || level === 'error') {
      recent.push({ at: now(), level, event: String(event).slice(0, MAX_STR), error: typeof fields?.error === 'string' ? fields.error.slice(0, 64) : null });
      if (recent.length > ring) recent.shift();
    }
  };
  const mk = (level) => (event, fields) => { note(level, event, fields); sink(level, event, fields); };
  return {
    debug: mk('debug'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    /** 最近的告警和错误（只有事件名和错误类型）。 */
    recent: () => recent.map((r) => ({ ...r })),
    counts: () => Object.fromEntries(counts),
  };
}
