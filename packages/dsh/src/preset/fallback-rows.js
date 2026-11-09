// 读不到 DSH 的「标准模式」（standard）时用的精简副本（D112）。只为了一件事：用插件预设开过的旧会话照样打得开、能聊。
// 照 DSH 0.2.1-rc.3 的 dsh-web-app/presets/standard.patch.yml 抄的，去掉了委派（子代理、工作流）、计划模式的长文本和定时任务；
// 平台条件在模块加载时就算好（standard 里是 !!js 表达式）。正常情况下用不到它：插件启动时读的是 standard 当时的行（含主人在
// DSH 编辑器里的改动），自检里「预设」一项会说现在用的是哪一份。
export const FROM_DSH = '0.2.1-rc.3';

const win = process.platform === 'win32';

/** @returns {object[]} 一份新的行（调用方可以随便改）。 */
export function fallbackRows() {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent powered by the {{model}} model.' } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: win },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !win },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    {
      id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
  ];
}
