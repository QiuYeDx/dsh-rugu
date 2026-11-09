# rugu-core

[如故（dsh-rugu）](https://github.com/QiuYeDx/dsh-rugu)的记忆核心。一个人设只有一段人生：感知入库、认人认物、情节与事实、激活与遗忘、五路回想、分寸判断。

它不认识任何宿主和入口（零宿主依赖，Node ≥ 22.16，`node:sqlite`），由宿主实现 LLM、嵌入、重排、预算这些端口再接上来。一般不需要直接装它：在 DeepSeek Harness 里装 `dsh-rugu` 就会带上。

接口说明见仓库的 [docs/实现/模块与接口.md](https://github.com/QiuYeDx/dsh-rugu/blob/main/docs/实现/模块与接口.md)。

MIT
