// 清洗的通用部分（§7.1 第 2 步、§10.4、§12.3）。纯函数，不知道任何平台的格式：
//   - 入库前（forStore）：删令牌、cookie、口令赋值、私钥块、JWT、≥ N 位的 hex / base64 串；URL 去掉 query 和账号口令；
//     本机路径换成占位；去掉控制字符和不可见字符（零宽字符、双向控制符、标签字符这类常被用来夹带指令或冒充名字的）。
//   - 调 LLM 前、注入前（forPrompt）：再做一遍上面的，然后【】换「」、方括号换全角（中和 [m12]、[U1] 这类编号）、
//     中和模板插值（{{x}}、${x}）、折叠换行。
// 平台相关的转义（唤醒头的方括号、宿主自己的插值语法）不在这里，由 ports.sanitizer 在这之后做（评审:UV-03）。
// 这些都是安全上的通用写法（凭据的语法形状），不是判断内容的词表。

export const REDACTED = '[已删除]';
export const TOKEN_MARK = '[令牌]';
export const PATH_MARK = '[本机路径]';

// 控制字符（保留 \n、\t）
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
// 不可见字符：格式类（零宽、双向控制、BOM、软连字符、标签字符……）+ 几个看起来是字母其实不显示的填充符
// \u4f8b\u5916\uff1a\u5939\u5728\u4e24\u4e2a\u8868\u60c5\u4e4b\u95f4\u7684\u96f6\u5bbd\u8fde\u63a5\u7b26\uff08\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 \u8fd9\u79cd\u7ec4\u5408\u8868\u60c5\u7684\u4e00\u90e8\u5206\uff0c\u53bb\u6389\u4f1a\u62c6\u6210\u4e09\u4e2a\u4eba\uff1b\u5b83\u85cf\u4e0d\u4e86\u5b57\uff09
const INVISIBLE_RE = /(?!(?<=\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]?)\u200d(?=\p{Extended_Pictographic}))[\p{Cf}\u115f\u1160\u3164\uffa0\u2800]/gu;

/** 去掉控制字符和不可见字符，统一换行。名字、场合称呼、群公告也用它。 */
export function stripInvisible(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').replace(INVISIBLE_RE, '');
}

/** 名字、称呼：去不可见字符，折叠空白，去首尾空白。 */
export function cleanLabel(text) {
  return stripInvisible(text).replace(/\s+/g, ' ').trim();
}

const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// 带账号口令的 URL：scheme://user:pass@host
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@:]+:[^/\s@]*@/gi;
// URL 里不含汉字和全角标点（中文正文常常紧贴着 URL 写，不能一起吞掉）
const HTTP_URL_RE = /\bhttps?:\/\/[^\s<>"'`）)」』】\]\p{Script=Han}　-〿！-｠]+/giu;
// 没有 scheme 的「域名/路径?k=v」
const BARE_QUERY_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s?#<>"'\p{Script=Han}　-〿！-｠]*)?)\?[^\s#<>"'\p{Script=Han}　-〿！-｠]*=[^\s<>"'\p{Script=Han}　-〿！-｠]*/giu;
const FILE_URL_RE = /\bfile:\/\/[^\s<>"']+/gi;
const WIN_PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/]?)*/g;
const UNC_PATH_RE = /\\\\[^\\\s]+\\[^\s]*/g;
const ENV_PATH_RE = /%[A-Za-z_][A-Za-z0-9_]*%[\\/][^\s"'<>|]*/g;
const POSIX_PATH_RE = /(?<![\w.\/~-])(?:~|\/(?:home|Users|root|tmp|var|etc|opt|usr|mnt|media|srv|private|Volumes|data|sdcard|storage|run|proc|sys|dev|Library|Applications|System))\/[^\s"'<>|]+/g;
const AUTH_HEADER_RE = /\b((?:proxy-)?authorization)\s*[:=：＝]\s*(?:(?:bearer|basic|token|digest)\s+)?[^\s,;，；]+/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const COOKIE_RE = /\b((?:set-)?cookie)\s*[:=：＝]\s*[^\n]*/gi;
const SECRET_KV_RE = new RegExp(
  '\\b((?:access|refresh|id|auth|session|csrf|xsrf)[_-]?token|api[_-]?key|apikey|app[_-]?(?:secret|key)|client[_-]?secret'
  + '|secret[_-]?key|private[_-]?key|access[_-]?key(?:[_-]?id)?|session[_-]?id|sessionid|token|secret|password|passwd|pwd|passphrase)'
  + '(\\s*[:=：＝]\\s*)("[^"\\n]*"|\'[^\'\\n]*\'|[^\\s&,;，；。\'"]+)', 'gi');
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;

/**
 * 一串字母数字像不像令牌（而不是普通的词、带连字符的标题）：要同时有字母和数字，并且
 * 有一段（按 - _ . / + = 切开）≥ minLen，或者大小写混合、平均每段 ≥ 8 个字符。
 */
function tokenLike(run, minLen) {
  if (!/[A-Za-z]/.test(run) || !/\d/.test(run)) return false;
  const segs = run.split(/[-_./+=]+/).filter(Boolean);
  if (segs.some((s) => s.length >= minLen)) return true;
  const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run);
  const avg = segs.reduce((a, s) => a + s.length, 0) / Math.max(1, segs.length);
  const digits = (run.match(/\d/g) ?? []).length;
  return mixedCase && avg >= 8 && digits / run.length >= 0.1;
}

/** URL：去掉 query；fragment 里带 = 或 & 的（常装着令牌）也去掉。 */
function scrubUrl(url) {
  const hashAt = url.indexOf('#');
  const before = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt + 1) : '';
  const q = before.indexOf('?');
  const base = q >= 0 ? before.slice(0, q) : before;
  return hash && !/[=&]/.test(hash) ? `${base}#${hash}` : base;
}

/**
 * 入库前的通用清洗。
 * @param {string} text
 * @param {{longTokenChars?: number}} [opt]
 * @returns {string}
 */
export function genericForStore(text, opt = {}) {
  const minLen = Math.max(8, Math.floor(opt.longTokenChars ?? 32));
  let s = stripInvisible(text);
  if (!s) return s;
  s = s.replace(PEM_RE, TOKEN_MARK);
  s = s.replace(URL_USERINFO_RE, '$1');
  s = s.replace(HTTP_URL_RE, (u) => scrubUrl(u));
  s = s.replace(BARE_QUERY_RE, '$1');
  s = s.replace(FILE_URL_RE, PATH_MARK);
  s = s.replace(UNC_PATH_RE, PATH_MARK);
  s = s.replace(ENV_PATH_RE, PATH_MARK);
  s = s.replace(WIN_PATH_RE, (m) => (m.length > 3 ? PATH_MARK : m));
  s = s.replace(POSIX_PATH_RE, PATH_MARK);
  s = s.replace(AUTH_HEADER_RE, `$1: ${REDACTED}`);
  s = s.replace(BEARER_RE, `Bearer ${REDACTED}`);
  s = s.replace(COOKIE_RE, `$1: ${REDACTED}`);
  s = s.replace(SECRET_KV_RE, `$1$2${REDACTED}`);
  s = s.replace(JWT_RE, TOKEN_MARK);
  // 长 hex 串（哈希、令牌）
  s = s.replace(new RegExp(`(?<![A-Za-z0-9])[0-9a-fA-F]{${minLen},}(?![A-Za-z0-9])`, 'g'), TOKEN_MARK);
  // 长 base64 / base64url 串
  s = s.replace(new RegExp(`(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{${minLen},}`, 'g'), (m) => (tokenLike(m, minLen) ? TOKEN_MARK : m));
  return s;
}

/**
 * 调 LLM 前、注入前的通用清洗（在 genericForStore 之后）。
 * @param {string} text
 * @param {{longTokenChars?: number}} [opt]
 * @returns {string}
 */
export function genericForPrompt(text, opt = {}) {
  let s = genericForStore(text, opt);
  s = s.replace(/【/g, '「').replace(/】/g, '」');
  s = s.replace(/\[/g, '［').replace(/\]/g, '］');
  s = s.replace(/\{\{/g, '｛｛').replace(/\}\}/g, '｝｝').replace(/\$\{/g, '＄｛');
  s = s.replace(/[ \t]*\n[\s]*/g, ' / ').replace(/[ \t\u3000]{2,}/g, ' ');
  return s.trim();
}
