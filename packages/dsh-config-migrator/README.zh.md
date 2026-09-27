# dsh-config-migrator

把 DSH（DeepSeek Harness）的 profile 迁到另一台机器——插件集合、钉死的精确版本、
加载顺序、参数、启用/禁用状态——并用 boot-free 的 `dsh --dump-config` 基准，
证明目标机上**生效的配置**与来源一致。

> **状态：P1 完成。** CLI + Core 引擎 + agent 工具 + 设置页「配置迁移」分区 +
> typert Remote 网关全部实现并通过验收（导出真实 profile → 在全新 `$DSH_HOME`
> 恢复 → `--dump-config` 与快照基准逐行一致）。36 个单元测试，全程不 boot Cordis。
>
> **尚未发布到 npm。** 目前请用 `link:` 从本地 checkout 安装——见[安装](#安装)。
>
> English: [README.md](README.md)

---

## 为什么需要它

DSH profile 是 `$DSH_HOME` 下的**声明式文件状态**，由模板 bundle、profile 补丁、
机器级 home 补丁、CLI 覆盖层逐层叠加而成（见 `DESIGN.md` §3）。把整个
`$DSH_HOME` 拷到另一台机器是行不通的：里面混着 boot 生成的文件、绝对路径、
本机密钥，以及属于旧机器的 store 产物。

本插件把**真值文件**当作搬运单位，保持字节保真，并给出可验证的结果：

| 真值文件 | 承载内容 |
| --- | --- |
| `package.json` | 依赖 + `dsh.profile.bundles`（加载顺序） |
| `cordis.patch.yml` | 参数与启用/禁用状态（逐行脱敏） |
| `pnpm-workspace.yaml` | workspace 布局 |
| `pnpm-lock.yaml` | 精确版本（含 `github:` 解析结果） |

`cordis.yml` 是 boot 生成的，永远不随快照走。恢复不靠猜：引擎全程不 boot 任何
Cordis 树，因此在 DSH 根本起不来的机器上也能导出与恢复。

## 做与不做

**做**

- 导出单个、多个或全部 profile（`--all`），并附带机器级 home 配置层。
- **默认脱敏**疑似密钥，并在 `manifest.json` 里按 **文件 + 行号**记录，恢复后可
  精确回填。
- 分析可移植性，提前告知换机器后会坏的地方（绝对路径、`link:`/`file:` 目标、
  模板 bundle、环境变量引用）。
- 恢复到一个**新的空 profile**：暂存文件 → `pnpm install --frozen-lockfile` →
  修复 lockfile 相对链接 → 校验生效配置；任一步失败会回滚暂存文件。

**不做（v1 边界）**

- 不恢复到**非空** profile——v1 直接拒绝并建议换个名字（合并模式规划在 P2）。
- 不搬运**环境变量**：引用 `$NAME` 的值只报告、不脱敏，需在目标机器自行配置。
- 不安装**模板自带 bundle**（如 `@deepseek-ai/dsh-base`）：目标 DSH 安装必须能提供。
- 不会让 `link:`/`file:` 依赖在目标机上凭空存在——链接会重建为绝对路径，但目标
  目录必须真实存在。

## 环境要求

- Node.js ≥ 20（开发于 24.x）
- pnpm 11.x（`packageManager: pnpm@11.7.0`）——恢复时用于安装依赖
- 一个提供 `dsh` CLI 的 DSH 安装。只用到 boot-free 子命令（`--dump-config`），
  所以导出/校验不需要可用的凭据或插件。若 `dsh` 不在 `PATH`，设置 `DSH_MIGRATE_DSH`。

## 安装

**从 npm（发布后可用）：**

```sh
dsh plugin --profile <name> add dsh-config-migrator
```

**从本地 checkout（今天可用）：**

```sh
# 1. 构建（bin 垫片走 lib/，必须先构建）
pnpm install
pnpm build

# 2. link 安装需要先接好盒内开发依赖
node packages/dsh-config-migrator/scripts/link-inbox.mjs <DSH checkout 路径>

# 3. 链接进某个 profile，然后重启/重载 DSH 让 roster 重新扫描
dsh plugin --profile <name> add "link:<repo 路径>/packages/dsh-config-migrator"
```

bundle 补丁层（`cordis.patch.yml`）会在活树里注册三个 agent 工具，client bundle
则挂上设置页分区。

> `@deepseek-ai/dsh-tools` 作为 DSH 安装的**盒内包**消费（其传递依赖未发布），
> link 安装时由 `link-inbox.mjs` 负责对接；它同时 vendor 了 checkout 的 typert
> 生成器（npm 发布的生成器与协议不自洽）并 junction 了 client 开发类型。
>
> `pnpm install` 会覆盖这些 junction——**每次装完依赖都要重跑 `link-inbox.mjs`**。

## 快速上手

```sh
# 旧机器
dsh-migrate export --profile web --out ./snapshots

# 把 ./snapshots/dsh-migrate-web-<时间戳> 拷到新机器，然后：
dsh-migrate inspect ./dsh-migrate-web-<时间戳>            # 读报表
dsh-migrate restore ./dsh-migrate-web-<时间戳> --dry-run   # 预览计划
dsh-migrate restore ./dsh-migrate-web-<时间戳> --yes       # 执行

# 最后：按 manifest.json 的 redactions 清单回填被脱敏的密钥
```

## 使用指南：CLI

```
dsh-migrate export  [--profile <name>]... | --all  [--out <dir>] [--no-redact --yes]
dsh-migrate inspect <snapshot-dir>
dsh-migrate restore <snapshot-dir> [--profile <name>] [--with-home] [--force] [--dry-run] [--yes]
```

| 选项 | 适用 | 含义 |
| --- | --- | --- |
| `--profile <name>` | export（可重复）/ restore | export：要导出的 profile；**restore：目标 profile 名**（默认沿用快照里的原名） |
| `--all` | export | 导出 `$DSH_HOME/profiles` 下全部 profile（与 `--profile` 互斥） |
| `--out <dir>` | export | 快照输出目录（默认当前目录） |
| `--no-redact` | export | 密钥明文写入快照，**必须同时给 `--yes`** |
| `--with-home` | restore | 同时写入机器级配置层 |
| `--force` | restore | 机器级配置层已存在时覆盖（原文件先备份为 `.bak-<时间戳>`） |
| `--dry-run` | restore | 只打印计划，不做任何改动 |
| `--yes` | restore | 跳过交互确认（stdin 非 TTY 时必需） |
| `--help`、`-h` | 任意 | 打印用法 |

`export` 总是捕获机器级 home 层；是否在目标机**写入**由恢复时的 `--with-home` 决定。

**快照命名**：`dsh-migrate-<scope>-<UTC 时间戳>`，scope 是 profile 名（多个用 `+`
连接）或 `all`。**时间戳是 UTC**。

**恢复流程**：打印/确认计划 → 暂存文件 → `pnpm install --frozen-lockfile` →
把 `link:`/`file:` 依赖修复为绝对目标 → 写 home 层（仅 `--with-home`）→ 校验。
安装或校验失败会回滚暂存文件。

**校验结果**三态：

- `✅ dump-config 行结构与快照基准一致（id 集合 + 禁用位）`
- `⚠️ 与基准不一致`，并附差异明细
- `跳过（原因）`——例如没有可用的 `dsh`，或快照没有 `composed-config.yml` 基准
  （导出时 `dsh` 不可用）

**退出码与错误形态**：参数问题打印 `dsh-migrate: <说明>` 加 `--help` 提示，退出码 1；
引擎类错误（例如快照里没有 `manifest.json`）目前会直接抛 Node 栈并退出码 1。

## 使用指南：设置页

安装后，client bundle 会在 DSH 设置页增加 **「配置迁移 / Config Migration」** 分区，
包含三张卡片：

| 卡片 | 字段 |
| --- | --- |
| 导出 | profile（逗号分隔）、*全部* 勾选、输出目录 |
| 查看 | 快照目录 |
| 恢复 | 快照目录、目标 profile（可选）、*仅预览*（默认勾选）、*写入机器级配置* |

返回结果以 JSON 形式贴在卡片下方。与 CLI 的两处差别：恢复默认走 dry-run；UI
**无法覆盖**已存在的机器级配置（它固定发送 `force: false`），这种情况请用 CLI 或
agent 工具。

## 使用指南：agent 工具

bundle 会注册三个工具，让 agent 替你完成整个迁移：

| 工具 | 参数 | 超时 |
| --- | --- | --- |
| `migrate_export` | `all`、`profiles[]`、`outDir` | 120 秒 |
| `migrate_inspect` | `snapshotDir`（必填） | 30 秒 |
| `migrate_restore` | `snapshotDir`（必填）、`targetProfile`、`withHome`、`force`、`dryRun` | 600 秒 |

agent 工具**永不**明文导出密钥（`noRedact` 固定为 false），且 `migrate_export`
总是包含 home 层。用自然语言说即可——"把我的 `web` profile 导出，再在本机还原成
`fresh-copy`"——模型会依次调用这三个工具，并从每次返回里读到脱敏数、警告数和
校验结论。

## 快照里有什么

```
dsh-migrate-web-20260927083636/
├── manifest.json              机器可读索引（恢复的"通讯录"）
├── requirement.md             人读报表：插件清单、加载顺序、统计、脱敏清单、
│                              可移植性警告、操作指引
├── home/cordis.patch.yml      机器级配置层
└── profiles/web/
    ├── package.json           依赖 + dsh.profile.bundles
    ├── cordis.patch.yml       参数 / 启用禁用状态（已脱敏）
    ├── pnpm-workspace.yaml
    ├── pnpm-lock.yaml         精确版本
    └── composed-config.yml    `dsh --profile web --dump-config` 基准
```

`manifest.json` 记录来源信息（`dshVersion`、`platform`、`homeLabel`），每个 profile 的
`bundles` 加载顺序、`dependencies`、`patchEntryCount`、`composedAvailable`、
`redactions` 清单，home 层状态，以及全部 `warnings`。

`requirement.md` 是为人和 agent 生成的可读报表，恢复过程**从不解析**它：原生文件
加 `manifest.json` 才是真值。

## 密钥安全

脱敏逐行进行且保守，因此注释、`!!js` 表达式、YAML 块标量、字节级顺序都原样保留。

- **敏感键名**——`key`、`token`、`secret`、`password`、`credential`、
  `authorization`、`passwd`：作为独立键、`snake_case`/`kebab-case` 段、或
  camelCase 边界（`apiKey`、`api_key`、`api-key`）时命中。匹配有边界意识，
  所以 `monkey` **不会**被脱敏。
- **密钥形态**——`sk-…`、`gh[pousr]_…`、`github_pat_…`、JWT（`eyJ….….…`）、
  base64 ≥ 40 字符、hex ≥ 32 字符。
- **环境变量引用**——`$NAME` / `${NAME}` 只报 `env-reference` 警告、从不脱敏，
  因为快照带不了环境变量。
- 每条脱敏都按**文件 + 行号**记进 `manifest.json`，恢复后回填是机械操作；有脱敏时
  恢复流程会明确告诉你条数。
- `--no-redact --yes`（仅 CLI）会把明文密钥写进快照——**这种快照绝不能外传**。
  agent 工具做不到这一点。

## 可移植性警告

| 类型 | 含义 |
| --- | --- |
| `absolute-path` | 补丁行里含本机专属路径 |
| `non-registry-dependency` | 依赖用了指向来源机器的 `link:`/`file:` spec |
| `stale-link-target` | lockfile 里的链接已失效，恢复时会重建 |
| `template-bundle` | 该 bundle 由 DSH 安装提供（如 `@deepseek-ai/dsh-base`），不由快照安装 |
| `env-reference` | 某个值读取环境变量，需在目标机配置 |

真实导出的一例：

```
- [absolute-path] profiles/web/cordis.patch.yml 第 16 行疑似包含绝对路径，换机器后需核对
- [non-registry-dependency] (web) 依赖 dsh-vision-router 使用 link:C:/Users/…/dsh-vision-router spec
- [template-bundle] (web) @deepseek-ai/dsh-base 是模板自带 bundle，不由快照安装
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `dsh-migrate: build output missing — run pnpm build` | 在包目录执行 `pnpm build` |
| `Cannot find package 'tsx'` 或 link 安装下依赖缺失 | 先 `pnpm install`，再重跑 `node scripts/link-inbox.mjs <checkout>` |
| 校验显示 `跳过` | 设置 `DSH_MIGRATE_DSH` 指向 dsh 可执行文件，才能捕获并比对基准 |
| 恢复时目标被拒绝 | v1 只恢复到空 profile——用 `--profile <新名字>` |
| 机器级配置层已存在 | 加 `--force`（旧层会备份为 `.bak-<时间戳>`） |
| Windows 下警告里出现 `link:C://Users//…` | 早先安装写入的双斜杠链接，恢复前在快照的 `package.json` 里修正 |

## 开发

```sh
pnpm install
node packages/dsh-config-migrator/scripts/link-inbox.mjs <DSH checkout 路径>
pnpm build       # 协议包 tsc + 插件包 tsdown + client bundle
pnpm test        # node:test + tsx，无需 boot（36 个测试）
pnpm typecheck
```

仓库布局：本包 + `packages/dsh-typert-protocol`（vendor 的 DSH Remote 协议副本，
让 `./typert` 与 `./remote` 不依赖某个已发布的协议版本即可解析）。

## 文档

- `DESIGN.md` —— 完整设计：文件模型、分层、决策记录、待决问题
- `docs/architecture.html`（位于仓库根目录，即本包往上两级的 `../../docs/`）——
  自包含可交互架构图，出处锚定在本仓库
- `README.md` —— English

## 许可证

MIT
