// 测试用的小工具：临时目录一律建在仓库的 .tmp/ 下（C 盘快满了，不用系统临时目录）。
// 实现在 fakes/tmp.js（随包发布的 createTestCore 也要用，见那里的说明）；这里只转出去，仓库里的测试照旧从这里拿。
export { REPO_ROOT, TMP_ROOT, tmpDir, rmDir } from './fakes/tmp.js';
