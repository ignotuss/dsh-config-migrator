# dsh-config-migrator 设计文档（DSH 配置迁移插件）

- **版本**：v0.2（命名与仓库结构定稿）
- **项目**：`dsh-config-migrator` —— 导出/恢复 DSH profile（插件清单 + 参数配置）的迁移插件
- **状态**：待评审

---

## 1. 项目概述

### 1.1 目标

把一个 DSH 实例（源机器）的 profile 完整导出为**可移植快照**，在另一台机器（目标机器）上恢复出**插件集合、精确版本、加载顺序、全部参数配置、启用/禁用状态**完全一致的新 profile。

### 1.2 非目标（v1 明确不做）

- 会话数据、Graph Memory、用户自建 agent presets、telemetry 数据（这些是"数据"而非"插件配置"）
- 恢复到**已存在内容**的 profile（合并模式，P2）
- 密钥加密打包（P2）
- 打包 node_modules 的离线模式（P3）

### 1.3 核心设计原则

1. **声明即真相**：DSH 的插件与配置状态全部落盘于文本文件（见 §3），快照 = 原样搬运这些文件 + 生成报表，**不做运行时自省，不做格式转换**。
2. **双产物**：`manifest.json` + 原样配置文件是**真值**（恢复时唯一依据）；`requirement.md` 是**生成的人读报表**（审阅、给 agent 读，恢复不依赖它）。
3. **恢复默认只增不改**：v1 只恢复到空 profile（= 目标机器上新建 profile），天然无冲突。
4. **安全默认**：导出默认对疑似密钥值打码；恢复前必须 dry-run 预览。

---

## 2. 术语表

| 术语 | 含义 |
|---|---|
| **profile** | 一套命名的 DSH 配置方案，对应 `$DSH_HOME/profiles/<名字>/` 目录。自带模板：`web`（带 GUI）、`headless`（无界面）；其他名字从 `dsh-base` 起步 |
| **bundle** | 声明 `dsh.bundle.patch` 的 npm 包：一个包 = 一层补丁层，插入 profile 的层级栈 |
| **plugin** | 广义：profile 的 `dependencies` 里装的 npm 包。是 bundle 的会进入层级栈；非 bundle 的是普通依赖库 |
| **patch layer（补丁层）** | YAML 数组，元素是 loader 补丁条目（`id` 定位的 `config` 覆盖、`disabled: true`、insert 列表；允许 `!!js`） |
| **profile 层** | `<profile>/cordis.patch.yml`：该 profile 的用户改动 |
| **home 层（机器级层）** | `$DSH_HOME/cordis.patch.yml`：作用于本机所有 profile，优先级高于 profile 层 |
| **快照（snapshot）** | 本插件导出的自包含目录（P2 起支持单文件 zip） |

---

## 3. 现状基础与设计依据（已核实）

以下事实来自对 DSH 源码的核实，是本设计的地基。路径均相对于 DSH 仓库（`C:\Users\23992\Desktop\ds_harness`）：

| # | 事实 | 出处 |
|---|---|---|
| F1 | 插件安装 = `dsh plugin --profile <p> add <pkg>`，本质是转发给 pnpm，在 profile 目录内执行；装包结果记录在 profile 的 `package.json` 的 `dependencies`，版本由 profile 目录内 `pnpm-lock.yaml` 钉死 | `apps/cli/src/plugin.ts` |
| F2 | 层级栈顺序记录在 `package.json` 的 `dsh.profile.bundles` 数组；声明了 `dsh.bundle.patch` 的依赖包会加入栈（reconcile 按安装状态而非依赖 diff） | 同上 |
| F3 | profile 目录由 `initProfile` 初始化，含四个文件：`package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml`；pnpm 随后生成 `pnpm-lock.yaml` 与 `node_modules/`；`cordis.yml` 每次 boot 被重写为空根（**非用户数据，快照排除**） | `packages/boot/app-boot/src/profile.ts:152` |
| F4 | 补丁层合成顺序：bundle 层（`dsh.profile.bundles` 顺序）→ profile 层 → home 层 → `--patch` 覆盖层 → telemetry 开关 | `apps/cli/src/profile-boot.ts:131` |
| F5 | home 层路径 `$DSH_HOME/cordis.patch.yml`；`$DSH_HOME` 由环境变量或 `~/.dsh` 决定 | `packages/util/home-paths/src/index.ts:87`、`apps/cli/src/profile-boot.ts:49` |
| F6 | `dsh --profile <p> --dump-config` 可不 boot 合成出**生效配置**（含注释标注每层来源）；`--dump-default-config` 只看 bundle 层 | `apps/cli/src/dump-config.ts` |
| F7 | 运行态插件树有只读投影 Remote（挂载/禁用状态），供 GUI 与校验使用 | `packages/host/plugin-inventory` |
| F8 | `dsh` 启动器（commander）只有 profile / plugin / dump-config 三种模式，**无第三方子命令扩展点**；`dsh snapshot` 需要启动器补丁或独立 bin | `apps/cli/src/args.ts`、`bin.ts` |
| F9 | git 依赖的 prepare 构建脚本被 pnpm 拦截，需在 `pnpm-workspace.yaml` 的 `allowBuilds` 放行；CLI 已有针对性报错提示 | `apps/cli/src/plugin.ts:147` |
| F10 | GUI 设置页已有 Plugins 分区（插件卡片 + inventory），双半插件（host + client，经 cordis-client-runner）可挂新设置分区 | `packages/client/ui-settings-plugins`、`packages/client/ui-settings-plugin-inventory` |

**设计推论**：

- **导出侧不需要 boot 任何树**：读取 `$DSH_HOME/profiles/` 下文件即可，引擎是纯 Node 库。
- **"全部 profile"导出 = 遍历 `$DSH_HOME/profiles/`**（排除 `node_modules/`、`cordis.yml`），没有隐藏状态。
- **版本复刻 = 原样带走 `package.json`（依赖声明）+ `pnpm-lock.yaml`（精确版本）**，恢复时 `pnpm install --frozen-lockfile`。
- **"参数状态"复刻 = 原样带走 `cordis.patch.yml`（profile 层 + home 层）**，零转换零失真。

---

## 4. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│                    dsh-config-migrator                      │
│                                                             │
│  ┌──────────────────┐  ┌─────────────────────────────────┐ │
│  │ cli/  独立 bin    │  │ plugin/  双半插件                 │ │
│  │ dsh-migrate      │  │  ┌───────────┐  ┌─────────────┐  │ │
│  │ export/restore/  │  │  │ host 行    │  │ client 行   │  │ │
│  │ inspect          │  │  │ RPC 服务   │  │ 设置页分区   │  │ │
│  │ （无 boot，随包    │  │  │ agent 工具 │  │ 导出/恢复 UI │  │ │
│  │  安装进 profile   │  │  └─────┬─────┘  └──────┬──────┘  │ │
│  │  的 .bin）        │  │        └────────┬───────┘        │ │
│  └────────┬─────────┘  │                 ▼                │ │
│           │            │  ┌─────────────────────────────┐  │ │
│           └────────────┼─▶│ core/  引擎（纯 Node，无 cordis│  │ │
│                        │  │ 依赖，boot-free）              │  │ │
│                        │  │  pack / unpack / redact /     │  │ │
│                        │  │  report / pnpm 编排 / verify  │  │ │
│                        │  └─────────────────────────────┘  │ │
│                        └─────────────────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

- **core/**：唯一实现真值逻辑的地方（读 profile、打包、脱敏、报表、装包、校验）。CLI、GUI、agent 工具都只是它的壳。
- **cli/**：独立可执行文件 `dsh-migrate`。由于 F8（启动器无扩展点），它**不依赖** `dsh` 启动器；随包安装进 profile 的 `node_modules/.bin`，任何装了本插件的 DSH 都能跑。
- **plugin/**：DSH bundle（声明 `dsh.bundle.patch`）。host 行提供 RPC（供 client 调用）与 agent 工具；client 行在设置页注册 "配置迁移 (Config Migration)" 分区。
- **可选启动器补丁**（另册）：给 DSH 启动器加 `snapshot` 子命令，内部转发到本包 bin，获得 `dsh snapshot export` 别名。因需改动 DSH 本体（F8），作为可选增强，不影响主链路。

### 4.1 导出流程

```
export(scope, outDir)
  1. 解析 scope：单 profile（校验名字合法） | all（遍历 $DSH_HOME/profiles/，跳过 node_modules/、cordis.yml）
  2. 逐 profile 读取：package.json、cordis.patch.yml、pnpm-workspace.yaml、pnpm-lock.yaml（有则收）
  3. 读取 home 层：$DSH_HOME/cordis.patch.yml（按决策：总是随快照走）
  4. 脱敏：对 patch 文件应用规则 §7.1，记录指针到 manifest.redactions
  5. 分析：依赖 spec 是否含 file:/link:/git+（可移植性警告）；
            config 值是否含绝对路径/盘符（机器相关警告）
  6. 生成 manifest.json + requirement.md
  7. 写出快照目录 dsh-migrate-<profile|all>-<UTC时间戳>/
```

### 4.2 恢复流程（v1：仅空 profile）

```
restore(snapshot, targetProfile, {dryRun, withHome})
  1. 校验快照：manifest.schemaVersion 兼容、文件齐备
  2. 目标 profile 目录必须不存在或为空目录（仅含生成的 cordis.yml 视为空）
     —— 不满足则报错退出（P2 提供 merge）
  3. dry-run：打印将安装的包（名字+版本）、将写入的文件、脱敏数、警告数 → 无 --yes 则等确认
  4. staging：创建目标目录，写入 package.json / pnpm-workspace.yaml /
      cordis.patch.yml（含占位符）/ pnpm-lock.yaml
  5. 安装：在 profile 目录内执行 pnpm install --frozen-lockfile
     （复用 dsh plugin 的 spawn 模式：Windows 走 shell shim；无 pnpm 报 ENOENT 清晰报错）
  6. bundle 校验：逐一检查 dsh.profile.bundles 各条目
     a. 在 dependencies 中的 → 已由 pnpm 装好，验证其声明 dsh.bundle.patch
     b. 不在 dependencies 中的（模板 bundle，如 dsh-base/dsh-web-app）→
        属于"安装自有"，目标机器必须由自身安装提供；验证可解析，否则明确报错
        （版本漂移风险点，见 §10）
  7. home 层：仅当 with-home 且目标 $DSH_HOME/cordis.patch.yml 不存在；
     已存在则要求 --force 并自动备份为 .bak-<时间戳>
  8. 验证：dsh --profile <target> --dump-config 成功执行；
     与快照内保存的 composed-config.yml（脱敏版）做结构性 diff（行 id 集合、禁用位）
  9. 输出恢复报告 + 脱敏补填清单（用户按清单手工补密钥）
  失败清理：步骤 4-5 失败时回滚 staging 目录（保留日志与完整报错）
```

---

## 5. 快照格式规范（v1）

### 5.1 目录结构

```
dsh-migrate-web-20260101T120000Z/          (--all 时: dsh-migrate-all-…)
├── manifest.json              真值：机器可读清单 + 脱敏指针 + 警告
├── requirement.md             报表：人/agent 可读摘要
├── profiles/
│   └── <profile-name>/
│       ├── package.json           原样（dependencies + dsh.profile.bundles）
│       ├── cordis.patch.yml       原样（脱敏后）
│       ├── pnpm-workspace.yaml    原样（含 allowBuilds）
│       ├── pnpm-lock.yaml         原样（有则收；精确版本钉死）
│       └── composed-config.yml    导出时 dsh --dump-config 的输出（脱敏），
│                                  恢复后 diff 校验的基准
└── home/
    └── cordis.patch.yml           原样（脱敏后）
```

### 5.2 manifest.json schema（v1）

```json
{
  "schemaVersion": 1,
  "tool": "dsh-config-migrator",
  "toolVersion": "0.1.0",
  "createdAt": "2026-01-01T12:00:00.000Z",
  "source": {
    "dshVersion": "0.x.y",           // 尽力读取，取不到为 "unknown"
    "platform": "win32",             // 供路径类警告判定
    "homeLabel": "~/.dsh"            // 符号化展示，绝不落机器绝对路径
  },
  "profiles": {
    "web": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      "dependencies": { "dsh-config-migrator": "^0.1.0" },
      "patchEntryCount": 3,
      "redactions": [
        { "file": "profiles/web/cordis.patch.yml",
          "line": 4,
          "hint": "apiKey" }
      ]
    }
  },
  "home": { "included": true, "patchEntryCount": 1, "redactions": [] },
  "warnings": [
    { "kind": "absolute-path", "profile": "web",
      "file": "profiles/web/cordis.patch.yml",
      "message": "rows[1].config.workspace 是绝对路径，换机器需核对" },
    { "kind": "non-registry-dependency", "profile": "web",
      "message": "依赖 some-local-plugin 使用 file: spec，指向导出机器的本地路径，恢复时需人工处理" }
  ]
}
```

### 5.3 requirement.md 结构（自动生成）

```markdown
# DSH 配置快照报表
- 生成时间 / 来源 DSH 版本 / 平台
- 每个 profile：插件清单表（包名 | 版本 | 是否 bundle | 补丁条目数 | 启用状态*）
- 脱敏清单（位置 + 提示，恢复后需补填）
- 可移植性警告（绝对路径 / 本地依赖 / 平台差异提示）
- 恢复操作指引（目标机器的 3 步操作）
- 环境变量提示：DSH 会读取分层环境变量（loadLayeredEnv），
  快照不包含环境变量；若某插件密钥来自环境变量，需在目标机器自行配置
```

\* 启用状态来自 composed-config.yml 中各行 `disabled` 位与是否存在。

---

## 6. 导出设计细节

### 6.1 范围选择（已定）

| 选项 | 行为 |
|---|---|
| `--profile <name>` | 仅该 profile + home 层 |
| `--all` | 遍历 `$DSH_HOME/profiles/` 所有目录（跳过 `node_modules/`、`cordis.yml`）+ home 层 |

home 层默认随快照导出（含在 `--all` 与单 profile 中）。

### 6.2 脱敏规则（v1，默认开启）

对 patch YAML 做**保守打码**（宁多勿漏，误伤可在报表中看到并补回）：

1. 字段名匹配 `/key|token|secret|password|credential|authorization/i` 的字符串标量 → 替换为 `<REDACTED>`；
2. 值形态命中（`sk-`/`ghp_`/`gho_` 前缀、长 base64、形似 JWT 的 `eyJ...` 三段结构）→ 同样打码；
3. 每个打码点记录：文件、JSON pointer、提示语（由字段名生成）；
4. 只替换字符串标量，保证 YAML 仍合法；`!!js` 表达式原样保留（其中引用的环境变量名不改）。

`--no-redact` 显式关闭（CLI 强警告；GUI 不提供该选项）。

### 6.3 可移植性警告（v1）

- **绝对路径**：patch 值中匹配 `^[A-Za-z]:[\\/]`、`^/`、含 `$DSH_HOME` 实际展开路径的值 → 警告并给出位置；
- **非 registry 依赖**：`dependencies` 中出现 `file:`/`link:`/`git+` spec → 警告（lockfile 里的 `file:` 链接指向绝对路径，恢复时需人工处理）；
- **模板 bundle 漂移**：`bundles` 中不在 `dependencies` 的条目，报表中单独列出"由目标 DSH 安装提供"，提醒版本需一致。

### 6.4 composed-config.yml 的获取

导出时调用 `dsh --profile <name> --dump-config`（F6）抓取生效配置，脱敏后存入快照，用途：① 报表中"启用状态"的来源；② 恢复后 diff 校验基准。若机器上无 `dsh` 命令则跳过（manifest 记为 `composed: "unavailable"`，恢复时校验降级为"dump-config 能跑通即可"）。

---

## 7. 恢复设计细节

### 7.1 目标判定（v1）

- 目标目录不存在 → 干净，直接恢复；
- 存在且为空（或仅含 `cordis.yml` 这类 boot 生成文件）→ 视为空，恢复；
- 存在且有用户内容 → **拒绝**，提示"v1 仅支持恢复到空 profile；合并模式见 P2"。可用 `--profile <新名字>` 换名恢复，规避冲突。

### 7.2 安装环节

- 复用 `apps/cli/src/plugin.ts` 的成熟模式：`spawn pnpm`、Windows `.cmd` shim、ENOENT 时输出"未安装 pnpm"；
- 优先 `pnpm install --frozen-lockfile`（复刻精确版本）；失败时降级 `pnpm install` 并在报告中显著标注"版本未钉死"；
- git 依赖构建被拦时，复用 CLI 的 allowBuilds 指引话术（F9）；
- **链接修复**（实测发现的关键坑）：pnpm lockfile 把 `link:`/`file:` 依赖存成相对 profile 目录的路径，新 home 下重建的 junction 必然悬空。安装后按快照 package.json 保留的绝对 spec 重建链接；目标机器上不存在该目录时明确警告；
- 恢复完成后的 bundle 结构以快照原样为准（package.json 与 bundles 数组是导出时的一致快照），仅做解析性 sanity 检查。

### 7.3 home 层策略（已确认：恢复时单独确认）

home 层影响目标机器**所有** profile，因此：

- 默认 `--with-home` 为关，恢复命令/界面必须显式确认；
- 目标已有 home 层 → 拒绝并建议备份合并，`--force` 才允许覆盖（先自动 `.bak-<时间戳>` 备份）；
- GUI 中该确认独立成一步，不与 profile 恢复捆绑。

### 7.4 脱敏补填

恢复后生成 `补填清单`：逐条列出 `文件 + 行号 + hint`，用户打开目标 profile 的 `cordis.patch.yml` 按清单替换 `<REDACTED>`。GUI 中提供逐条输入表单（P1 可先做只读清单 + 打开文件按钮）。

### 7.5 恢复后验证

1. `dsh --profile <target> --dump-config` 必须成功退出（boot 配置层面无语法错误）；
2. 与快照 `composed-config.yml` 对比：行 id 集合一致、`disabled` 位一致（忽略 `<REDACTED>` 值差异）；
3. 差异输出为报告的一部分，任何差异都可见。

---

## 8. 接口定义

### 8.1 CLI（独立 bin：`dsh-migrate`）

| 命令 | 参数 | 行为 |
|---|---|---|
| `export` | `--profile <name> \| --all`（必选一）、`--out <dir>`、`--no-redact`、`--yes` | 生成快照目录，打印报表路径 |
| `inspect <snapshot>` | — | 打印 manifest 摘要 + requirement.md |
| `restore <snapshot>` | `--profile <name>`（目标名，默认用原名）、`--with-home`、`--force`、`--dry-run`、`--yes` | 恢复流程 §4.2 |

### 8.2 GUI（设置页 "配置迁移 (Config Migration)" 分区）

- **Export 卡片**：范围单选（profile 下拉 | all）、输出目录选择、警告/脱敏统计预览、"导出"按钮 → 进度 → 结果路径 + 报表预览；
- **Restore 卡片**：快照路径选择、目标 profile 名输入、"Dry-run 预览"（diff 视图）→ "恢复"按钮（未预览前禁用）→ 报告 + 补填清单。

### 8.3 Agent 工具（host 侧，供会话内 agent 驱动）

| 工具 | 参数 | 返回 |
|---|---|---|
| `migrate_export` | `{ all?, profiles?, outDir? }` | 快照路径 + 警告/脱敏统计 |
| `migrate_inspect` | `{ snapshotDir }` | manifest 摘要 + 报表文本 |
| `migrate_restore` | `{ snapshotDir, targetProfile?, withHome?, force?, dryRun? }` | 计划/报告 + 补填清单 |

这使"新 DSH 装好本插件后，让 agent 读快照并自动完成复刻"成为可能——即最初设想的场景，且人可随时接管。
**安全约束**：agent 工具永远不做明文导出（无 `noRedact` 参数）；`migrate_restore` 超时上限 10 分钟（pnpm 安装时间）。

---

## 9. 密钥处理路线（已定）

- **P1**：默认打码 + 恢复后手工补填（§6.2、§7.4），快照可安全分享；
- **P2**：加密模式。导出时输入口令，用口令派生密钥（scrypt/argon2 + AES-256-GCM）加密含密钥的独立文件 `secrets.enc`，manifest 记录 `secretsMode: "encrypted"`；恢复时输口令自动回填，无需手工；口令遗失 = 密钥不可恢复，文档明示。

---

## 10. 异常与边界情况

| 情况 | 处理 |
|---|---|
| 目标 profile 非空 | v1 拒绝（§7.1） |
| 目标无 pnpm | 清晰报错 + 安装指引（沿用 CLI 话术） |
| `--frozen-lockfile` 失败 | 降级普通 install + 显著警告"版本未钉死" |
| 模板 bundle 在目标 DSH 中缺失/版本不符 | 明确列出缺失条目，指引升级/降级目标 DSH（安装自有部分本插件不代为安装） |
| git 依赖构建被拦 | 输出 allowBuilds 放行指引 |
| **file:/link: 本地依赖** | 恢复后按 package.json 的绝对 spec **重建链接**（pnpm lockfile 的相对链接在新 home 下必然悬空——实测发现）；目标机器上不存在时明确警告需人工迁移 |
| **link 目标在源机已失效** | 导出时 `stale-link-target` 警告（源机本身已坏，快照如实记录） |
| 目标已有 home 层 | 拒绝 + `--force` 才备份覆盖 |
| 恢复时 profile 正被 DSH 使用（HMR 存活） | 报告警告：改文件会被活树热载入，建议停用后再恢复；不做文件锁（DSH 无锁机制） |
| 脱敏后 YAML 被手改坏 | 恢复第 1 步读全部文件并校验 manifest，v1 语法以目标 dump-config 通过为准 |
| 跨平台迁移（Windows ↔ Linux） | patch 值路径警告 + 恢复后 dump-config 校验兜底；平台 gate 的行差异由校验报告 |

---

## 11. 安全考虑

1. 快照可能含敏感配置：默认脱敏是安全底线，`--no-redact` 只在 CLI 且需强确认；
2. 报表/警告中只出现字段名与位置提示，不输出疑似密钥的明文值（即便是脱敏对象也不回显原文）；
3. home 层含全局偏好，导出时仍走脱敏，恢复时独立确认；
4. P2 加密模式使用标准 KDF + AEAD，口令不落盘、不写入 manifest。

---

## 12. 分阶段路线图

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **P1** | core 引擎（pack/redact/report/restore/dry-run/verify）；CLI（export/inspect/restore）；设置页基础 UI；3 个 agent 工具；恢复到空 profile；requirement.md | 用本机 web profile 导出→在临时 DSH_HOME 下恢复→`--dump-config` 与源 diff 一致（除 REDACTED） |
| **P2** | 加密密钥模式；zip 打包；合并模式（非空 profile，覆盖/保留/逐条确认）；composed-config 深度 diff；`dsh snapshot` 启动器补丁（可选册） | 加密快照口令错误拒恢复、正确则密钥自动回填；merge 冲突全部有确定性规则 |
| **P3** | 深状态钩子约定（`exportState()/importState()`，供第三方插件扩展）；GM/会话/presets 导出；离线便携模式（含 node_modules） | 钩子文档 + 至少一个示例插件接入；离线快照在断网机器恢复成功 |

---

## 13. 项目结构（仓库布局）

对齐 DSH 仓库内插件包的既有约定（bundle 声明 `dsh.bundle.patch`、双半 client 声明 `dsh.client`、tsdown 打包、peerDependencies 模式），本仓库独立成包，随 GitHub 公开：

```
dsh-config-migrator/
├── package.json                name / dsh.bundle.patch / dsh.client / bin / exports / files / license
├── cordis.patch.yml            本包的 bundle 补丁层：插入 host 行 + client 行
├── tsconfig.json               构建配置（tsdown，与 DSH 插件包一致）
├── tsdown.config.ts
├── src/
│   ├── index.ts                包入口（引擎 re-export + 类型）
│   ├── core/                   引擎：纯 Node、零 cordis 依赖、boot-free
│   │   ├── manifest.ts         清单读写与 schema 校验
│   │   ├── pack.ts             导出/打包
│   │   ├── unpack.ts           恢复
│   │   ├── redact.ts           脱敏
│   │   ├── report.ts           requirement.md 生成
│   │   ├── pnpm.ts             pnpm spawn 编排（复用 dsh plugin 的成熟模式）
│   │   └── verify.ts           dump-config 校验/对比
│   ├── host/                   host 半：3 个 agent 工具（Remote RPC 网关 P2 接入 typert）
│   └── client/                 client 半：设置页"配置迁移"分区（P2，web 平台）
├── bin/
│   └── dsh-migrate.js          CLI 入口（package.json 的 bin → dsh-migrate）
├── tests/                      core 单测（临时 DSH_HOME 夹具）+ client 测试
├── README.md / README.zh.md    安装、命令、脱敏说明、恢复指引
├── LICENSE                     MIT（与 DSH 一致）
└── .gitignore
```

package.json 关键字段（对齐已核实的 DSH 约定）：

```json
{
  "name": "dsh-config-migrator",
  "type": "module",
  "bin": { "dsh-migrate": "bin/dsh-migrate.js" },
  "exports": {
    ".": { "types": "...", "default": "..." },
    "./host": { "types": "...", "default": "..." },
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^",
    "@deepseek-ai/dsh-invariants": "workspace:^"
  },
  "license": "MIT"
}
```

实现补充（已定案）：

- `@deepseek-ai/dsh-tools`（盒内包）**不声明为任何依赖**：npm 发布集不完整（其依赖 `dsh-type-meta` 未发布），registry 安装会失败；运行时由 DSH 安装的 profile 回退层（healed fallback）解析，开发期用 junction 指向本地 DSH checkout。类型侧用本地 shim（`src/host/shims.d.ts`）。

发布/公开配套（GitHub）：

- LICENSE、README（含脱敏默认行为说明与恢复三步指引）、.gitignore；
- P1 收尾时加最小 CI（lint + 单测）；
- 开发期 peer 依赖通过 registry 的 rc 版本或 `link:` 指向本地 DSH 仓库解析，发布时由发布流程对齐正式版本号。

## 14. 决策记录

| # | 决策点 | 结论 | 状态 |
|---|---|---|---|
| D1 | 载体形态 | 插件 + CLI 命令 | 已定 |
| D2 | CLI 落点 | 独立 bin `dsh-migrate`（启动器无扩展点，F8）；可选启动器补丁 | 已定 |
| D3 | 导出范围 | 单 profile / 全部 profile 二选一；home 层一并导出 | 已定 |
| D4 | 快照格式 | 原生文件真值 + manifest.json + requirement.md 报表 | 已定 |
| D5 | 密钥 V1 | 默认打码 + 恢复时补填 | 已定 |
| D6 | 密钥 V2 | 口令加密（AES-256-GCM + scrypt） | 已定 |
| D7 | 恢复 V1 | 仅空 profile（= 目标机器新建 profile），dry-run 前置 | 已定 |
| D8 | 恢复 V2 | 合并进现有 profile | 已定 |
| D9 | home 层恢复 | 独立确认；已存在则拒绝，`--force` 备份覆盖 | 已定 |
| D10 | 包名 | `dsh-config-migrator`（突出配置迁移概念）；CLI bin 名 `dsh-migrate`；发布前再定 scope/registry | 已定 |
| D11 | 项目目录 | workspace 下 `dsh-config-migrator/`，独立 package，对齐 DSH 插件包结构（见 §13），含 `dsh.bundle.patch` 声明与 bin | 已定 |
| D12 | GUI 分区名 | "配置迁移 (Config Migration)"，与包名概念一致 | 已定 |
| D13 | dsh-tools 消费方式 | 不声明依赖（npm 发布集缺 dsh-type-meta）；运行时靠 DSH 安装回退层，开发期 junction + 类型 shim | 已定 |
| D14 | Remote RPC / GUI | P1 交付工具面；typert Remote 网关 + 设置页分区延后（typert 生成器要求 DSH monorepo 布局，独立仓库集成成本高） | 已定 |

---

## 15. 附：关键代码引用

| 关注点 | 文件 |
|---|---|
| 插件安装/转发/reconcile 逻辑（恢复侧复用参考） | `apps/cli/src/plugin.ts` |
| profile 初始化与目录结构（F3） | `packages/boot/app-boot/src/profile.ts` |
| 补丁层合成顺序（F4）、home 层路径（F5） | `apps/cli/src/profile-boot.ts` |
| 生效配置 dump（F6，导出/校验用） | `apps/cli/src/dump-config.ts` |
| 启动器命令分发（F8） | `apps/cli/src/args.ts`、`apps/cli/src/bin.ts` |
| home 路径解析 API（F5） | `packages/util/home-paths/src/index.ts` |
| 运行态插件投影（F7） | `packages/host/plugin-inventory` |
| 设置页插件分区（F10） | `packages/client/ui-settings-plugins`、`packages/client/ui-settings-plugin-inventory` |
