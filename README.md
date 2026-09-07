# dsh-preset-router-ptc

DeepSeek Harness（DSH）Agent Preset：任务感知思维模式路由 → PTC/run_code（router-ptc）。

本 preset 是 [dsh-preset-router-standard](https://github.com/kaijia323/dsh-preset-router-standard) 的 PTC 分支：保留其 router-standard 路由思路（首条真实用户消息在 `spec` / `weak` / `react` 行为带之间路由，首轮注入匹配 persona 与 RL 接口工具面），并把首个持久工具调用后的“开放完整 Standard 工具集”改为切换到 DSH 内置 **PTC/run_code（Code Mode）** 单一入口。

## 两种 preset 模式

本 preset 与 [dsh-preset-router-standard](https://github.com/kaijia323/dsh-preset-router-standard) 是同一套任务感知路由思路的两种 DSH preset 模式：

| 模式 | 仓库 | 首个工具调用后的工具面 |
| --- | --- | --- |
| **Router Standard** | [dsh-preset-router-standard](https://github.com/kaijia323/dsh-preset-router-standard) | 开放完整 Standard 原生工具集 |
| **PTC RunCode（本 preset）** | [dsh-preset-router-ptc](https://github.com/kaijia323/dsh-preset-router-ptc) | 切换到 DSH 内置 PTC/run_code（Code Mode）单一入口 |

- **Router Standard**：任务感知路由 + RL 接口还原；首个持久工具调用后开放完整 Standard 工具集。
- **PTC RunCode**：继承 Router Standard 的首轮路由与 RL 接口；首个持久工具调用后用 DSH 0.1.2+ 的 PTC presentation API（`presentAs('ptc')`，与官方 `@deepseek-ai/dsh-agent-tool-presentation` 同一套）切到 `run_code` 单一入口，system 保持短 prompt（persona + 协作口吻）。

## 特性

- **首轮与 router-standard 一致 + 协作式推理口吻**：首条真实用户消息分类为 `spec` / `react`，模糊文本进入 `weak` 由模型自行决定；首轮 system 为 RL 训练句 + `shell` / `str_replace_editor`，并以强约束锚定推理口吻为协作式（只用 `Let's ...` / `We need ...`，禁止 `Let me` / `I need`），避免 DeepSeek 在 runcode 场景下的预览版口吻。
- **首轮后切换 PTC/run_code**：第一个持久 `tool/call` 之后等 host 的 `codeRuntime` 就绪，再对 **该 agent 的 scope** 调用 `presentAs('ptc')`（DSH `ToolPresentationMode` 只有 `native` / `ptc` / `both`；`presentAs('code')` 不是合法模式，会被当成 `both`：SDK 注入了，grep/glob/read 仍可直接调）。官方 PTC preset 把 `@deepseek-ai/dsh-agent-tool-presentation` 写在 standing mount 上、从第一轮就是 `run_code`；本 preset 故意不写那一行，这样第一轮还能走 RL 原生工具面。
- **切换后 system 保持短 prompt**：`presentAs('ptc')` 生成的 `tools:ptc-only` + `tools:sdk`（约 33K）不再放进 `system`，而是在首个工具调用后作为一次性 durable inbox 消息注入对话；后续每轮 system 只保留 `router-persona` + `router-voice` 两段，因此 DeepSeek 的思维口吻与 router-standard 一致（`Let's` / `We need`，而不是预览版口吻 `Let me`）。
- **按 agent 隔离**：切换状态记录在 `WeakSet`（agent 粒度），只影响已触发首个工具调用的会话，不影响同 preset 下其他会话。
- **会话恢复安全**：模式从 durable session events 推导；已产生过 `tool/call` 的 resume / reload 会话会在下一条用户消息或下次 assembly 时自动补切到 PTC/run_code。
- **Agent 自优化工具**：内置 `dev_router_status` / `dev_router_mode` / `dev_mode_subagent`，会话可读取和调整自身路由。

## 目录结构

```text
dsh-preset-router-ptc/
├── preset.yml              # 预设元信息（名称 / 描述）
├── agent.cordis.yml        # Agent 平面组合：persona、工具、plan mode、compaction、delegation 等
├── router-bootstrap.mjs    # Cordis 路由插件：首轮注入、首轮后 PTC 切换、弱带引导、dev_* 工具
└── router-core.mjs         # 纯路由逻辑：分类、行为带、persona、工具面（零依赖）
```

## 安装

从 GitHub 克隆到 DSH 的 agent-presets 目录：

```bash
mkdir -p ~/.dsh/.agent-presets
git clone --depth 1 https://github.com/kaijia323/dsh-preset-router-ptc.git ~/.dsh/.agent-presets/dsh-preset-router-ptc
```

然后在新会话中选择 **PTC RunCode（首轮路由 → Code Mode）** 预设。

DSH 实际加载的是 `~/.dsh/.agent-presets/dsh-preset-router-ptc`，不是 GitHub 工作副本。改完代码后必须在该目录更新（pull 或覆盖文件）并**重启 `dsh web`**，只提交 GitHub 仓库不会让正在跑的会话切到 `run_code`。

> 如果之前安装过旧版本，可以先删除旧目录再克隆，避免残留文件：
>
> ```bash
> rm -rf ~/.dsh/.agent-presets/dsh-preset-router-ptc
> ```

## 使用

新会话选择本 preset 后：

- 第一轮仍是 RL 接口（`shell` + `str_replace_editor`）。
- 模型做出第一个持久工具调用后，自动切换到 PTC/run_code：后续请求只看到 Code Mode 的 `run_code` 入口；system 保持首轮的短 prompt（persona + 协作口吻），Code Mode SDK 已作为一条 durable 消息注入对话，不再进入 system。

可通过内置工具查看当前状态：

```text
dev_router_status    # 查看 mode / band / persona / core / promote-to / presentation / override
dev_router_mode ...  # 设置显式路由模式
dev_mode_subagent ... # 在隔离上下文中以其他模式运行任务
```

切换完成后 `dev_router_status` 会显示：

```text
promote-to=ptc (ptc=run_code / standard=full native catalog)
presentation=ptc/run_code
```

## 配置

`agent.cordis.yml` 中 `router-bootstrap` 的配置：

```yaml
config:
  routerMode: standard   # standard（默认）：首轮 RL 接口；spec：首轮保留全部 sections
  promoteTo: ptc         # ptc（默认）：首轮后切换到 PTC/run_code；standard：恢复完整 Standard 工具集
```

## 与 dsh-preset-router-standard 的差异

| 阶段 | dsh-preset-router-standard | dsh-preset-router-ptc |
| --- | --- | --- |
| 首轮 | RL 接口：shell + str_replace_editor | 相同 |
| 首个 `tool/call` 后 | 开放完整 Standard 原生工具集 | `agent.ctx.tools.presentAs('ptc')`（与官方 PTC presentation 同一 API），只保留 `run_code` |
| prompt sections | 保持首轮 RL persona | system 保持 `router-persona` + `router-voice`；`tools:ptc-only` / `tools:sdk` 作为一次性 inbox 消息注入 |
| 路由 / 弱带引导 / dev_* 工具 | 有 | 相同（另加 `router-voice` 口吻锚定） |

## 致谢

- 本 preset 是 [dsh-preset-router-standard](https://github.com/kaijia323/dsh-preset-router-standard) 的 PTC 分支，其 dsh preset 模式由 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)（MIT）作为参考设计，特别感谢 [yjh051108](https://github.com/yjh051108) 的 `router-standard` 预设与相关实测工作。
- 路由分类、行为带划分、弱带内路由、首轮工具面还原等核心思路均来自上述开源项目；本仓库在此基础上把首轮后的提升目标改为 PTC/run_code（Code Mode）。

## License

[MIT](LICENSE)
