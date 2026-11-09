// SelfProfilePort（§3.3、§5.7）：核心自我只放性格、口吻和价值观，是配置不是记忆。
// 文字来自私有 kit 的 core-self.md（路径在配置里，公开仓库里没有任何人设内容，§11.6）；文件改了每分钟重读一次。
import fs from 'node:fs';
import { sha } from '../host/util.js';

/**
 * @param {{hostConfig: () => object, fsImpl?: typeof fs, log?: object}} opt
 */
export function createSelfProfile({ hostConfig, fsImpl = fs, log = { warn() {} } }) {
  let cache = { file: null, mtime: -1, text: '', hash: 'empty', error: null };
  const load = () => {
    const file = hostConfig().self?.coreSelfFile || '';
    if (!file) { cache = { file: '', mtime: -1, text: '', hash: 'empty', error: null }; return cache; }
    let st = null;
    try { st = fsImpl.statSync(file, { throwIfNoEntry: false }); } catch { st = null; }
    if (!st) { cache = { file, mtime: -1, text: '', hash: 'empty', error: 'ENOENT' }; return cache; }
    if (cache.file === file && cache.mtime === st.mtimeMs) return cache;
    try {
      const text = fsImpl.readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
      cache = { file, mtime: st.mtimeMs, text, hash: text ? sha(text, 16) : 'empty', error: null };
    } catch (e) {
      cache = { ...cache, file, error: e?.code ?? 'READ_FAILED' };
      log.warn('self.read', { error: cache.error });
    }
    return cache;
  };
  load();
  return {
    coreSelf: () => ({ text: cache.text, hash: cache.hash }),
    principalLabel: () => String(hostConfig().self?.principalLabel ?? ''),
    get locale() { return hostConfig().self?.locale || 'zh'; },
    /** 文件改了就重读（调度器每分钟调一次）；返回有没有变化。 */
    refresh() { const before = cache.hash; load(); return before !== cache.hash; },
    status: () => ({ configured: !!cache.file, present: cache.mtime >= 0, chars: [...cache.text].length, hash: cache.hash, error: cache.error }),
  };
}
