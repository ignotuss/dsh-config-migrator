/**
 * Host half: three model-facing tools that drive the boot-free engine from
 * inside an agent session — export a snapshot, inspect one, and restore it.
 * The settings-UI Remote gateway comes in a later pass (typert wiring).
 * @module dsh-config-migrator/host
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readManifest } from '../core/manifest'
import { exportSnapshot } from '../core/pack'
import { REPORT_FILENAME, renderReport, writeReport } from '../core/report'
import { restoreSnapshot } from '../core/unpack'

/** Cordis plugin identity for Loader diagnostics. */
export const name = 'config-migrator'

/** Capability services required by the tools. */
export const inject = ['tools']

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

function errorText(error: unknown): string {
  return error instanceof Error ? `dsh-config-migrator 失败: ${error.message}` : `dsh-config-migrator 失败: ${String(error)}`
}

/** Register the three migration tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'migrate_export',
    description: '把 DSH profile 的插件与配置（含机器级配置层）导出为可移植快照目录；密钥默认脱敏。',
    parameters: {
      all: { type: 'boolean' as const, description: '导出 $DSH_HOME/profiles 下的全部 profile（与 profiles 二选一）' },
      profiles: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: '要导出的 profile 名列表',
      },
      outDir: { type: 'string' as const, description: '输出目录（默认当前工作目录）' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 120_000,
    execute: (args) => {
      try {
        const result = exportSnapshot({
          all: args.all === true,
          profiles: Array.isArray(args.profiles) ? args.profiles : [],
          outDir: typeof args.outDir === 'string' ? args.outDir : process.cwd(),
          noRedact: false,
          includeHome: true,
        })
        writeReport(result.snapshotDir, result.manifest)
        const redactions = Object.values(result.manifest.profiles)
          .reduce((sum, profile) => sum + profile.redactions.length, 0) + result.manifest.home.redactions.length
        const lines = [
          `快照已生成: ${result.snapshotDir}`,
          `profile: ${Object.keys(result.manifest.profiles).join(', ')}`,
          `脱敏处数: ${redactions}（恢复后需按 manifest.json 的 redactions 清单补填真实密钥）`,
          `警告: ${result.warnings.length}`,
          `报表: ${result.snapshotDir}/${REPORT_FILENAME}`,
        ]
        for (const warning of result.warnings) lines.push(`- [${warning.kind}] ${warning.message}`)
        return lines.join('\n')
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'migrate_inspect',
    description: '查看一个 DSH 配置迁移快照的摘要与 requirement.md 报表（不修改任何东西）。',
    parameters: {
      snapshotDir: { type: 'string' as const, required: true as const, description: '快照目录路径' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    execute: (args) => {
      try {
        const manifest = readManifest(args.snapshotDir)
        let report: string
        try {
          report = readFileSync(join(args.snapshotDir, REPORT_FILENAME), 'utf8')
        } catch {
          report = renderReport(manifest)
        }
        return `快照: ${args.snapshotDir}\n来源: dsh ${manifest.source.dshVersion} (${manifest.source.platform})\nprofile: ${Object.keys(manifest.profiles).join(', ')}\n机器级配置: ${manifest.home.included ? '已包含' : '未包含'}\n\n${report}`
      } catch (error) {
        return errorText(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'migrate_restore',
    description: '把配置迁移快照恢复到目标机器上的一个新（空）profile：装插件、写配置、校验生效配置。恢复前先用 dryRun 预览。',
    parameters: {
      snapshotDir: { type: 'string' as const, required: true as const, description: '快照目录路径' },
      targetProfile: { type: 'string' as const, description: '目标 profile 名（默认用快照里的原名）' },
      withHome: { type: 'boolean' as const, description: '同时写入机器级配置层（影响本机所有 profile，需谨慎）' },
      force: { type: 'boolean' as const, description: '机器级配置已存在时备份覆盖' },
      dryRun: { type: 'boolean' as const, description: '只预览计划不执行' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 600_000,
    execute: (args) => {
      try {
        const report = restoreSnapshot({
          snapshotDir: args.snapshotDir,
          targetProfile: typeof args.targetProfile === 'string' ? args.targetProfile : undefined,
          withHome: args.withHome === true,
          force: args.force === true,
          dryRun: args.dryRun === true,
        })
        const lines = [...report.plan]
        if (report.installed) {
          lines.push('', `恢复完成: profile ${report.profile} → ${report.targetDir}`)
          if (report.homeWritten) lines.push('机器级配置已写入' + (report.homeBackedUpTo !== undefined ? `（原文件备份到 ${report.homeBackedUpTo}）` : ''))
          switch (report.verification.status) {
            case 'verified':
              lines.push('校验: ✅ dump-config 行结构与快照基准一致')
              break
            case 'mismatch':
              lines.push(`校验: ⚠️ 与基准不一致\n${report.verification.detail}`)
              break
            case 'skipped':
              lines.push(`校验: 跳过（${report.verification.reason}）`)
              break
            default:
              break
          }
          if (report.redactionCount > 0) {
            lines.push(`注意: 有 ${report.redactionCount} 处密钥在导出时被脱敏，需人工补填到 cordis.patch.yml`)
          }
        }
        for (const warning of report.warnings) lines.push(`- ${warning}`)
        return lines.join('\n')
      } catch (error) {
        return errorText(error)
      }
    },
  }))
}
