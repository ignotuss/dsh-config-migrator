/**
 * requirement.md generation: a human/agent-readable report derived from the
 * manifest. Restore never reads it — it is documentation, not truth.
 * @module dsh-config-migrator/core/report
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Manifest } from './manifest'

export const REPORT_FILENAME = 'requirement.md'

function section(title: string, lines: string[]): string[] {
  return ['', `## ${title}`, ...lines]
}

function profileSection(name: string, manifest: Manifest): string[] {
  const profile = manifest.profiles[name]!
  const lines: string[] = []
  lines.push(`### profile: ${name}`)
  lines.push('', '**插件清单**（包名 → 版本声明，精确版本由 pnpm-lock.yaml 钉死）：', '')
  const deps = Object.entries(profile.dependencies)
  if (deps.length === 0) {
    lines.push('- （无）', '')
  } else {
    lines.push(...deps.map(([dep, spec]) => `- \`${dep}\` \`${spec}\``), '')
  }
  lines.push('**加载顺序**（`dsh.profile.bundles`）：', '')
  lines.push(...(profile.bundles.length === 0
    ? ['- （无）', '']
    : profile.bundles.map(bundle => `1. \`${bundle}\``)), '')
  lines.push('**统计**：', '')
  lines.push(`- 插件依赖数：${deps.length}`, `- 补丁行数：${profile.patchEntryCount}`,
    `- 生效配置基准：${profile.composedAvailable ? '已捕获（composed-config.yml）' : '未捕获（导出时无 dsh 命令）'}`,
    `- 脱敏数：${profile.redactions.length}`, '')
  return lines
}

/**
 * Render the requirement.md content for a manifest.
 */
export function renderReport(manifest: Manifest): string {
  const lines: string[] = []
  lines.push('# DSH 配置迁移快照报表', '')
  lines.push('> 本文件由 `dsh-config-migrator` 自动生成；恢复以 manifest.json 与',
    '> 快照内的原生文件为准，本报表仅供审阅。', '')
  lines.push('**生成信息**：', '')
  lines.push(`- 生成时间：${manifest.createdAt}`, `- 工具：${manifest.tool}@${manifest.toolVersion}`,
    `- 来源 DSH 版本：${manifest.source.dshVersion}`, `- 来源平台：${manifest.source.platform}`,
    `- 来源主目录：${manifest.source.homeLabel}`, '')

  lines.push('**包含的 profile**：', '')
  for (const name of Object.keys(manifest.profiles)) {
    lines.push(`- ${name}`, ...profileSection(name, manifest).map(line => `  ${line}`))
  }
  lines.push('')

  lines.push(...section('机器级配置层（home/cordis.patch.yml）', [
    manifest.home.included
      ? `已包含（补丁行数 ${manifest.home.patchEntryCount}，脱敏 ${manifest.home.redactions.length} 处）。恢复时需要显式确认，且会影响目标机器的所有 profile。`
      : '未包含。',
    '',
  ]))

  const redactionLines: string[] = []
  for (const [name, profile] of Object.entries(manifest.profiles)) {
    for (const item of profile.redactions) {
      redactionLines.push(`- \`${item.file}\` 第 ${item.line} 行：${item.hint}`)
    }
  }
  for (const item of manifest.home.redactions) {
    redactionLines.push(`- \`${item.file}\` 第 ${item.line} 行：${item.hint}`)
  }
  lines.push(...section('脱敏清单（恢复后需按此补填密钥）', redactionLines.length > 0
    ? redactionLines
    : ['- （无脱敏内容）']))
  lines.push('')

  const warningLines = manifest.warnings.length > 0
    ? manifest.warnings.map(item => `- [${item.kind}]${item.profile !== undefined ? ` (${item.profile})` : ''} ${item.message}`)
    : ['- （无）']
  lines.push(...section('可移植性警告', warningLines))
  lines.push('')

  lines.push(...section('恢复操作指引', [
    '1. 在目标机器安装本插件：`dsh plugin --profile <name> add dsh-config-migrator`',
    '2. 预览：`dsh-migrate restore <快照目录> --dry-run`',
    '3. 执行：`dsh-migrate restore <快照目录>`（默认恢复到同名新 profile；机器级配置需 `--with-home`）',
    '4. 按"脱敏清单"把真实密钥补填进目标 profile 的 cordis.patch.yml',
    '5. 注意：DSH 会读取分层环境变量，快照不包含环境变量——若某插件密钥来自环境变量，',
    '   需在目标机器自行配置（见上表 env-reference 警告）。',
    '',
  ]))

  return lines.join('\n')
}

/** Write requirement.md into a snapshot directory. */
export function writeReport(snapshotDir: string, manifest: Manifest): void {
  writeFileSync(join(snapshotDir, REPORT_FILENAME), renderReport(manifest))
}
