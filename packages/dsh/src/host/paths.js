// 数据位置（§12.1）。和宿主一样解析 DSH 的家目录：配置里给的 > 环境变量 DSH_HOME > ~/.dsh（空白的 DSH_HOME 当作没设）。
// 公开仓库里不写任何本机的私有路径：主人自己的位置（例如把库放在另一块盘上）写在私有 kit 的推荐配置里（§11.6）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_BYTES = 32;
/** 核心主库在数据目录里的文件名（rugu-core 的 MAIN_DB_FILE）：宿主只用它判断「库在不在」，不打开它。 */
export const MAIN_DB_FILE = 'persona-memory.db';

/**
 * 确保身份哈希密钥文件在（§12.3）。内置适配器的盐（§4.2：SettingId 里不含账号原值）由适配器自己从这个文件按 id 派生
 * （adapters/util.resolveSalt：盐必须稳定、保密、跟着备份走——备份包里有这个文件，§12.4.1；不另存盐文件）。
 * 核心打开时已经建好它；还没有时（只有测试和工具会走到）按核心同样的格式新建（32 字节 base64，mode 0600，不覆盖）。
 * 文件内容只在这里写，从不读出来打印。
 * @param {string} keyFile
 * @returns {boolean} 现在在不在
 */
export function ensureKeyFile(keyFile) {
  try { if (fs.statSync(keyFile).size > 0) return true; } catch (e) { if (e?.code !== 'ENOENT') return false; }
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, `${crypto.randomBytes(KEY_BYTES).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (e) { return e?.code === 'EEXIST'; }
}

/** 只展开 `~`、`~/`、`~\` 开头的路径。 */
export function expandHome(p) {
  const s = String(p ?? '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** @param {NodeJS.ProcessEnv} [env] */
export function resolveDshHome(env = process.env) {
  const v = String(env.DSH_HOME ?? '').trim();
  return v ? path.resolve(expandHome(v)) : path.join(os.homedir(), '.dsh');
}

/**
 * 插件用到的全部路径。
 * @param {{dshHome?: string, dataDir?: string}} [opt]
 */
export function resolvePaths({ dshHome = resolveDshHome(), dataDir = '' } = {}) {
  const data = dataDir ? path.resolve(expandHome(dataDir)) : path.join(dshHome, 'persona-memory');
  return Object.freeze({
    dshHome,
    configFile: path.join(dshHome, 'persona-memory.json'),       // 模式、预算、模型、阈值（§12.1）
    keyFile: path.join(dshHome, 'persona-memory.key'),           // 身份哈希密钥（§12.3），随私有 kit 备份
    backupKeyFile: path.join(dshHome, 'persona-memory-backup.key'),   // 备份加密的本机密钥（§12.4.3）
    embeddingKeyFile: path.join(dshHome, 'persona-memory-embedding.key'),   // 外部嵌入服务的 API Key（D127）：不进配置、日志、导出和备份
    dataDir: data,                                               // 主库、向量库、本机备份
    exportDir: path.join(data, 'backup', 'export'),              // JSONL 导出（管理页下载，§12.4.7）
    budgetFile: path.join(data, 'host-budget.json'),             // 后台花费的当天计数（只有数字）
    hostStateFile: path.join(data, 'host-state.json'),           // 自检要比较的上一次的值（Ollama 版本等）
  });
}
