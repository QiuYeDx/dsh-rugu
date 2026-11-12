// 测试用的临时目录：一律建在仓库的 .tmp/ 下（C 盘快满了，不用系统临时目录）。
// 放在 test/fakes 里是因为随包发布的 createTestCore（rugu-core/testing）要用它；仓库里其他测试经 test/helpers.js 用同一份。
//   从 npm 装的包里，「仓库根」按同样的相对位置算：<项目>/node_modules/rugu-core 往上两层，即 <项目>/.tmp。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const TMP_ROOT = path.join(REPO_ROOT, '.tmp');

/** 新建一个空的临时目录。 */
export function tmpDir(name) {
  const dir = path.join(TMP_ROOT, `test-${name}-${process.pid}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 删掉临时目录（Windows 上 SQLite 刚关的文件偶尔还占着，重试几次）。 */
export function rmDir(dir) {
  if (!dir || !path.resolve(dir).startsWith(TMP_ROOT)) throw new Error(`只删 .tmp 下的目录：${dir}`);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
