# dsh-layered-memory

给 **DeepSeek Harness（DSH）** 的四层记忆插件：

| 层 | 存什么 | 怎么写 | 怎么用 |
|---|---|---|---|
| **核心层** | 身份、根本人设、安全边界、授权规则 | 默认只读；只能走 `layered_core` 提案 + 用户授权 | 作为系统硬约束注入，不参与普通检索 |
| **内隐层** | 稳定偏好、表达风格、行为策略、技能倾向 | 主模型用 `layered_store(layer=implicit)` 观察；证据够了才由本地反射晋升 | 作为风格先验注入，不陈述为事实 |
| **外显长期** | 重要事件、事实、约定 | `layered_store(layer=explicit)` 或短期显著片段晋升 | 每轮按相关度召回摘要；`layered_search` 查细节 |
| **短期** | 最近对话、任务中间状态 | 自动写入，TTL 过期 | 只注入显著片段；过期前可晋升为候选 |

四层之外有两个横切能力：**审计**（`audit.jsonl`）和**遗忘调度**（TTL、衰减、归档、回收站、删除传播）。

它不调用额外的模型，不额外要 key。反射、检索、遗忘都是本地确定性逻辑；只有主模型自己决定调用工具时才会产生正常的工具调用开销。

---

## 安装（桌面版，推荐）

DSH 桌面版没有 `dsh` CLI 时，最稳的是用 profile 的 `cordis.patch.yml` 直接加载插件文件。DSH 支持在 patch 的 `insert` 里写绝对路径（会转成 `file://` URL）。

1. 先备份（`$DSH_HOME` 换成你的 DSH home，桌面版常见 `D:/dsh-data`）：

   ```bash
   cp "$DSH_HOME/profiles/desktop/cordis.patch.yml" "$DSH_HOME/profiles/desktop/cordis.patch.yml.bak-$(date +%Y%m%d-%H%M%S)"
   ```

2. 在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 末尾追加：

   ```yaml
   # === 分层记忆（dsh-layered-memory）===
   - insert:
       - id: layered-memory
         name: '/absolute/path/to/dsh-layered-memory/lib/index.js'
   ```

   Windows 路径用正斜杠即可，例如 `'D:/tools/dsh-layered-memory/lib/index.js'`。

3. 重启 DSH。首次启动会自动创建 `$DSH_HOME/layered-memory/`。

4. 打开 `$DSH_HOME/layered-memory/core/persona.md` 等三个文件，填入核心人设与边界。插件只读这些文件，不会自动改写。

> 也可以用环境变量 `LAYERED_MEMORY_HOME` 单独指定数据目录。

### 用 GitHub 安装（可选）

仓库：<https://github.com/yinling2024/dsh-layered-memory>

```bash
dsh plugin --profile desktop add github:yinling2024/dsh-layered-memory
```

或者手动克隆后，按上面的 profile patch 方式加载：

```bash
git clone https://github.com/yinling2024/dsh-layered-memory.git
```

装完重启 DSH。

### Linux / 服务器

插件零外部依赖，复制整个目录到服务器，然后在对应 profile 的 `cordis.patch.yml` 里加同样的 `insert`（绝对路径），重启 DSH 即可。

---

## 工具

| 工具 | 作用 |
|---|---|
| `layered_store` | 写外显长期（事件/事实）或内隐倾向（偏好/策略/技能）。外显支持 `factKey`：同一键只保留最新，旧条目标 `superseded` 但保留可审计 |
| `layered_search` | 按「相关度 + 新近 + 重要度 + 置信度」检索外显记忆；空 query 时用当前用户消息 |
| `layered_forget` | 删除一条外显记忆：默认进回收站 30 天，`hard=true` 彻底删除 |
| `layered_core` | `list` / `propose` / `apply` / `rollback`。`apply` 和 `rollback` 必须 `confirm: "APPLY"` |
| `layered_status` | 各层条数、待批准提案、数据目录、当前配置 |

### 核心层变更协议

1. 用户明确说「改核心人设」；
2. 模型调用 `layered_core(action="propose", file="persona", content="...")`；
3. 模型把返回的 diff 给用户看；
4. 用户明确授权后，模型才调用 `layered_core(action="apply", proposal_id="corep_...", confirm="APPLY")`；
5. 写入前自动备份到 `core/versions/`，可用 `rollback` 回滚。

提案默认有 **30 秒冷却**：刚生成的提案不能立刻 apply，强制中间过一次用户确认。可以在 `config.json` 的 `core.applyCooldownSeconds` 调整；设为 `0` 会取消这道时间门（不建议）。

---

## 数据目录

```
<DSH_HOME>/layered-memory/
  config.json                 # 所有可调项
  audit.jsonl                 # 追加式审计（谁在何时改了哪层）
  core/
    persona.md                # 核心人设（只读）
    boundaries.md             # 安全边界（只读）
    authorization.md          # 授权规则（只读）
    proposals/                # 核心变更提案
    versions/                 # 每次 apply/rollback 前的备份
  explicit/
    manifest.json             # 外显记忆索引（标题/类型/重要度/状态/来源）
    entries/                  # 记忆正文 markdown
    archive/                  # 衰减归档
    trash/                    # 回收站（默认 30 天）
  implicit/
    implicit.json             # 内隐参数 + 候选证据 + 每日更新计数
  short-term/
    <session>.json            # 每会话短期缓冲（TTL）
  diag.log                    # 插件诊断日志
```

外显记忆的元数据在 `manifest.json`，正文是普通 markdown，可以直接打开看。手工改正文/元数据后建议重启 DSH（检索索引有内存缓存）；日常写入走工具即可。

> 同一个 profile 里如果已经有 `dsh-fish-memory`、`dsh-memory` 之类的注入式记忆插件，建议只留一套常驻注入，避免同一段记忆被重复塞进上下文、白花 token。

---

## 配置

`config.json` 首次启动自动生成。常用项：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时插件不注册工具、不注入 |
| `prompt.coreMaxChars` | `6000` | 核心层注入上限 |
| `prompt.implicitMaxChars` | `900` | 内隐层注入上限 |
| `prompt.hint` | `true` | 是否注入一小段「你可以用这些工具」的提示 |
| `prompt.recallMaxChars` | `900` | 每轮长期召回上限 |
| `prompt.shortTermDigest` | `true` | 是否注入显著短期片段 |
| `recall.topK` | `5` | 每轮最多召回几条 |
| `recall.minScore` | `0.28` | 召回分数门槛 |
| `recall.alwaysFacts` | `2` | 每轮固定带几条高重要度语义事实（0 关闭） |
| `shortTerm.ttlMinutes` | `30` | 短期 TTL |
| `shortTerm.maxItems` | `40` | 每会话短期上限 |
| `shortTerm.autoCandidate` | `true` | 显著短期片段自动进外显候选 |
| `implicit.minEvidence` | `3` | 内隐晋升所需证据数 |
| `implicit.minDays` | `2` | 证据至少跨几天 |
| `implicit.dailyUpdates` | `3` | 内隐每日最多更新几个参数 |
| `implicit.maxStep` | `0.05` | 单次置信度变化上限 |
| `explicit.candidateBelow` | `0.5` | 低于这个重要度的新记忆先进候选 |
| `explicit.archiveAfterDays` | `120` | 低重要度记忆多久后归档 |
| `explicit.trashDays` | `30` | 回收站保留天数 |
| `core.applyEnabled` | `true` | 是否允许核心层 apply/rollback |
| `core.applyCooldownSeconds` | `30` | 提案生成后多久才允许 apply |

调低 `prompt.recallMaxChars` / `recall.topK` / `recall.alwaysFacts` 可以省 token；`alwaysFacts` 是每轮常驻的，最影响成本。

---

## 设计边界

- **内隐记忆不能改核心**：内隐参数只影响「怎么表达、怎么偏好」，不改变身份、安全边界、授权规则；核心层只能走显式提案。
- **不是所有对话都写**：外显写入靠工具或显著短期片段；短期过期即丢，只有显著片段会晋升。
- **遗忘不是一刀切**：短期 TTL；外显先降权、归档、回收站，最后硬删除；用户明确「忘掉」时走 `layered_forget`。
- **冲突有规则**：外显同 `factKey` 新值取代旧值（旧值保留）；内隐冲突按作用域和证据处理，用户纠正立即降权；与核心冲突的写入拒绝。
- **审计可追**：所有写入/取代/删除/核心变更都进 `audit.jsonl`。
- **不额外调模型**：没有后台 LLM 调用；只有主模型主动调用工具时才有开销。

## 自测

```bash
cd dsh-layered-memory
node --test test/*.test.js
```

测试覆盖：外显写入/检索/去重/事实键取代、回收站与硬删除、内隐证据反射与用户纠正、核心提案/冷却/APPLY 门控/回滚、短期 TTL/候选晋升、mock DSH 装配。

## 兼容性

- 实测目标：**DSH 0.2.1-rc.3**（`@deepseek-ai/dsh-tools` / `dsh-system-prompt` 同版本）。
- 使用 DSH 的 `systemPrompt.section/context`、`tools.register`、`agents.list`、`agent/inbox/inserted`、`agent/turn-stopping`、`ctx.interval`。
- 不依赖 `@deepseek-ai/*` 包，因此不需要改 profile 的 `pnpm-lock.yaml`，也不会覆盖 DSH 的依赖闭包。
