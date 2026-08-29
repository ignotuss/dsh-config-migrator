# dsh-config-migrator

把 DSH profile 的插件与配置导出为可移植快照，并在新的 DSH 实例上完整恢复：
插件集合、精确版本、加载顺序、参数、启用/禁用状态，并用 boot-free 的
`dsh --dump-config` 与快照基准逐行校验。

> **状态：P1 完成。** CLI + 引擎 + agent 工具 + 设置页"配置迁移"分区 +
> typert Remote 网关全部实现并通过验收（真实 profile 导出 → 全新 `$DSH_HOME`
> 恢复 → dump-config 与基准逐行一致；活树 boot 验证工具注册与 RPC 网关加载）。

## 原理

DSH profile 是 `$DSH_HOME` 下的声明式文件状态（见 `DESIGN.md` §3），引擎
全程不 boot 任何 Cordis 树：

- **导出**：真值文件逐字节复制（`package.json`、`cordis.patch.yml`、
  `pnpm-workspace.yaml`、`pnpm-lock.yaml`），用无 boot 的
  `dsh --profile <name> --dump-config` 捕获生效配置，保守脱敏疑似密钥，
  分析可移植性，生成 `manifest.json` + 人读报表 `requirement.md`。
- **恢复**：在目标机器上重建一个**新（空）** profile：落文件 →
  `pnpm install --frozen-lockfile`（精确版本）→ 修复 lockfile 相对链接
  （`link:`/`file:` 依赖按绝对路径重建）→ 可选写机器级配置层（显式
  `--with-home`）→ 与快照基准校验生效配置。

## 安装

```sh
dsh plugin --profile <name> add dsh-config-migrator
```

bundle 补丁层会在活树里注册三个 agent 工具（`migrate_export` /
`migrate_inspect` / `migrate_restore`），可以让 agent 替你完成整个迁移。

> `@deepseek-ai/dsh-tools` 作为 DSH 安装的盒内包消费（不从 registry 安装，
> 其传递依赖未发布）。**link 方式**开发安装时，先把它从你的 DSH checkout
> junction 进来：`node scripts/link-inbox.mjs <DSH checkout 路径>`。

## CLI

```sh
dsh-migrate export --profile web              # 导出单个 profile + 机器级层
dsh-migrate export --all --out ./snapshots    # 导出全部
dsh-migrate inspect <快照目录>                 # 只读查看
dsh-migrate restore <快照目录> --dry-run        # 恢复前预览
dsh-migrate restore <快照目录> --yes            # 恢复（同名 profile）
dsh-migrate restore <快照目录> --profile 新名字 --with-home --yes
```

- v1 只恢复到**空 profile**（= 新机器上新建 profile，天然无冲突）；合并模式
  规划在 P2。
- 机器级配置层影响本机**所有** profile：`--with-home` 需显式给出；目标已有
  该层时必须 `--force`（先自动备份为 `.bak-<时间戳>`）。
- 若 `dsh` 不在 PATH，用 `DSH_MIGRATE_DSH` 指向 dsh 可执行文件（用于版本探测
  与生效配置捕获/校验）。

## 密钥安全

导出默认对疑似密钥脱敏（敏感字段名、`sk-`/`ghp_`/JWT/长 hex 形态），位置按
文件 + 行号记录在 `manifest.json`。恢复后按清单把真实值补填进目标 profile 的
`cordis.patch.yml`。引用环境变量的值（`$NAME`）从不脱敏——快照不携带环境变量，
目标机器需自行配置（会以 `env-reference` 警告列出）。明文导出仅限 CLI 的
`--no-redact --yes`，agent 工具永远不做明文导出。

## 开发

```sh
# 仓库根（workspace 布局：packages/dsh-config-migrator + packages/dsh-typert-protocol）
pnpm install
node packages/dsh-config-migrator/scripts/link-inbox.mjs <DSH checkout 路径>
#  ^ 三件事：dsh-tools 开发 stub（类型 + 运行时 re-export）、
#     vendor checkout 的 typert 生成器（npm 发布集 rc.1 生成器与 rc.6 协议不兼容）、
#     junction client 开发类型（与浏览器模块表一致）
pnpm build       # 协议包 tsc + 插件包 tsdown（typert 产物）+ client bundle
pnpm test        # node:test + tsx，无需 boot
pnpm typecheck
```

> 注意：`pnpm install` 会覆盖 node_modules 里的 junction/stub，
> 重新安装依赖后需重跑 `link-inbox.mjs`。

完整设计见 `DESIGN.md`。许可证：MIT。
