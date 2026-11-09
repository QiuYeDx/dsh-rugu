<div align="center">

<img src="packages/dsh/assets/banner.webp" width="100%" alt="如故 · dsh-rugu：让 Agent 像一个真实存在的人">

[![npm](https://img.shields.io/npm/v/dsh-rugu)](https://www.npmjs.com/package/dsh-rugu)
[![license](https://img.shields.io/npm/l/dsh-rugu)](LICENSE)

[快速开始](#快速开始) · [怎么运作](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/图解.md) · [花费](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/花费.md) · [反馈问题](https://github.com/QiuYeDx/dsh-rugu/issues)

</div>

## 简介

如故（`dsh-rugu`）是一个 DeepSeek Harness（DSH）记忆插件。它想做的事只有一件：**让 Agent 像一个真实存在的人，有独立的记忆，只有一段人生。**

别的记忆插件记的是「你」：你的偏好、你说过的事。如故记的是「她自己经历过什么」：在哪儿、听谁说的、当时谁在场、她怎么想的。QQ 群、QQ 私聊、DSH 桌面（以及别的插件接进来的入口）里发生的事进同一份记忆。她回话前像人一样想起一部分，再自己判断这件事在这里能不能说。

多人、多场合、知道的事不随便说，都是「只有一段人生」的结果，不是单独加的功能。

> DSH 底层仍然是多个会话，如故统一的是她的经历和记忆，不是把这些会话合成一个。

现在是公开 beta。

## 功能

**记得**

- **一份记忆，所有入口**：在 QQ 里听到的，到 DSH 桌面也想得起来，反过来也一样。记得是在哪儿、从谁、当着谁知道的。
- **原话一直留着**：提炼出的事实、经历、人物印象是加在原话上的理解，随时能回到原话核对。
- **夜间整理**：每天在后台对照原话纠错、把经历沉淀成认识、重写人物印象。
- **工作记忆**：眼前这个人刚在别处跟她说的、她答应的、还开着的事，一说就在心里，不等后台提炼。
- **她自己的经验**：工具怎么用、哪儿踩过坑、被纠正过什么，下次用得上的时候想起来。

**想起来**

- **五路回想**：意思（向量）、字面、人和事、时间、在场的人，每轮回话前按眼前的话想起一些。
- **自己也能想**：`memory_recall`、`memory_note`、`memory_fix` 三个工具。

**分寸**

- **知道不等于说**：一件事在这里说不说、说多细，按谁说的、谁已经知道、多敏感、原场合的规矩逐条判断，不按场合一刀切。

**你看得见**

- **管理页**（DSH 设置里的「记忆」，只给主人）：看、改、删、撤回她的记忆，按场合开关，备份恢复，每天的后台花费和上限。
- **对比评测**：同一组用例在「有记忆 / 没记忆」下跑一遍，看它到底帮了多少。

## 快速开始

**1. 安装**

在 DSH「设置 → 插件」里添加插件，包名填 `dsh-rugu`，装完重启 DSH。或者用命令行：

```bash
dsh plugin --profile desktop add dsh-rugu
```

**2. 首次设置**

打开「设置 → 记忆」，走完几步设置（不用手写配置）。设置走完之前，插件不开库、不记任何东西。第一步会说清楚：

- 接上 QQ 之后，她在的群和私聊里的话都会被记下来（向导里会列出桥接放行的群，默认全选，不想记的取消；之后也能改）；
- 原文默认保留 2 年（可以改）；
- QQ 小号路线走的是第三方桥接，有封号风险，请用小号。

**3. 选一种「想起来」的方式（嵌入）**

三档都能用，之后可以换：

| 档位 | 要准备什么 | 差别 |
| --- | --- | --- |
| 不用嵌入 | 什么都不用 | 按字面、人和事、时间、在场的人回想；换个说法问同一件事容易想不起来 |
| 本机 Ollama | 自己装 [Ollama](https://ollama.com/download)，模型在设置页一键下载 | 完整的回想。按你的硬件推荐 4B 或 0.6B，向量在本机算，不花钱 |
| 外部服务 | 一个 OpenAI 兼容的 `/v1/embeddings` | 完整的回想。记忆文本会发给那个服务，设置页会提醒你 |

**4. 接 QQ（可选）**

如故接的是 [dsh-qq](https://github.com/h-D-ACE/dsh-qq) 桥接，只读它落盘的状态文件。在设置页找到桥接目录，一键打白名单补丁（有预览、可还原），彻底重启 DSH 后生效。

**5. 在 DSH 桌面里跟她聊**

新建任务时选 Agent 预设「人设聊天」。别的预设不受影响：写代码的会话不会被记住，也拿不到她的记忆。不要把它设成 DSH 的默认预设。

## 使用条件

- DeepSeek Harness，插件运行需要 Node ≥ 22.16（DSH 自带）。
- 后台提炼和整理走 DSH 的模型通道，花的是你 DSH 账号的余额，默认有每日上限，管理页能看到每一笔。详见[花费](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/花费.md)。
- 数据都在你自己的电脑上（`~/.dsh/persona-memory/`）。卸载插件不会删数据。
- QQ 这条路线依赖第三方桥接，账号风险请自己掂量，也请告诉群友他们的发言会被记录。

## 现在验证到哪一步

这是公开 beta。作者自己的 DSH 从 2026-11 初开始一直在线运行（dsh-qq 1.1.1）；全新环境里验证过 `dsh plugin add` 安装和首次设置向导。下面这些还没有实测过，碰到问题欢迎提 Issue：

- DSH 桌面版的「添加插件」按钮和插件列表显示（命令行 `dsh plugin add` 验证过）。
- 在线的 QQ 跑最新版 dsh-qq（只对照过 1.1.2 的代码，白名单补丁在副本上验证过）。
- 真实的外部嵌入服务（接口和测试连接只测到端口）。
- 全新安装之后的真实聊天和记忆提炼。

## 和 Anthropic 那篇文章

Anthropic 的《Components of agent memory》和如故同一周各自走到相近的结构：原话留底能直接搜、后台「做梦」整理、常驻注入保持小、少用硬规则。读完文章之后，如故又补了 5 处：对照原话纠错、只记以后用得上的、她自己的经验层、用法说明可以只讲目的、有记忆 / 没记忆的对比评测。文章没讲、如故多做的是分寸和隐私、每条记忆的来源、多人多场合。这里只是说明思路的来处，和 Anthropic 没有任何关系。

## 文档

| 文档 | 内容 |
| --- | --- |
| [图解](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/图解.md) | 整体链路：写入、回想、工作记忆、说话之前、后台任务、管理页 |
| [花费](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/花费.md) | 后台调了哪些模型、怎么记账、上限和预设 |
| [模块与接口](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/实现/模块与接口.md) | 实现契约：各模块的职责、接口、取舍（D 号表） |

## 开发

```bash
npm install
node scripts/run-tests.mjs
node scripts/check-boundaries.mjs
```

`packages/core` 是通用记忆核心（`rugu-core`，不依赖任何宿主），`packages/dsh` 是 DSH 插件（`dsh-rugu`）。本地联调用 `node packages/dsh/scripts/install.mjs`（默认只预演）。

## 许可

[MIT](https://github.com/QiuYeDx/dsh-rugu/blob/main/LICENSE)
