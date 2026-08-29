/**
 * Host gateway: one service that is BOTH the typert Remote surface for the
 * settings UI (later client half) AND the registrar of the three agent tools.
 * The loader takes the default export, so everything must live on the class.
 * @module dsh-config-migrator/host/remote
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from 'zod'
import { readManifest } from '../core/manifest'
import { exportSnapshot } from '../core/pack'
import { REPORT_FILENAME, renderReport, writeReport } from '../core/report'
import { restoreSnapshot, type RestoreOptions } from '../core/unpack'

/** Wire shape of the export call (JSON boundary). */
export interface ExportRequest {
  all: boolean
  profiles: string[]
  outDir: string
}

export interface ExportReply {
  snapshotDir: string
  profiles: string[]
  redactionCount: number
  warnings: string[]
}

/** Wire shape of the restore call (JSON boundary). */
export interface RestoreRequest {
  snapshotDir: string
  targetProfile?: string
  withHome: boolean
  force: boolean
  dryRun: boolean
}

export interface RestoreReply {
  installed: boolean
  profile: string
  targetDir: string
  plan: string[]
  verification: string
  warnings: string[]
  redactionCount: number
}

export interface InspectReply {
  summary: string
  report: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? `dsh-config-migrator 失败: ${error.message}` : `dsh-config-migrator 失败: ${String(error)}`
}

/** Runtime surface of the in-box tools service (typed locally; see shims.d.ts). */
interface ToolsHost {
  tools: {
    register(definition: unknown): () => void
  }
}

/**
 * Host plane of the plugin: Remote invocations for the settings UI plus the
 * three model-facing tools. Tool registration happens in the constructor so
 * one row (this class as the package default export) provides both surfaces.
 */
export class ConfigMigratorGateway extends TypertRemoteService {
  static inject = ['tools']

  constructor(ctx: Context) {
    super(ctx, 'configMigrator')
    const tools = (ctx as Context & ToolsHost).tools
    tools.register(defineTool({
      name: 'migrate_export',
      description: '把 DSH profile 的插件与配置（含机器级配置层）导出为可移植快照目录；密钥默认脱敏。',
      parameters: {
        all: { type: 'boolean' as const, description: '导出 $DSH_HOME/profiles 下的全部 profile（与 profiles 二选一）' },
        profiles: { type: 'array' as const, items: { type: 'string' as const }, description: '要导出的 profile 名列表' },
        outDir: { type: 'string' as const, description: '输出目录（默认当前工作目录）' },
      },
      output: { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
      timeoutMs: 120_000,
      execute: (args: Record<string, any>) => {
        try {
          const reply = this.exportSnapshot({
            all: args.all === true,
            profiles: Array.isArray(args.profiles) ? args.profiles : [],
            outDir: typeof args.outDir === 'string' ? args.outDir : process.cwd(),
          })
          const lines = [
            `快照已生成: ${reply.snapshotDir}`,
            `profile: ${reply.profiles.join(', ')}`,
            `脱敏处数: ${reply.redactionCount}（恢复后需按 manifest.json 的 redactions 清单补填真实密钥）`,
            `警告: ${reply.warnings.length}`,
            `报表: ${reply.snapshotDir}/${REPORT_FILENAME}`,
          ]
          for (const warning of reply.warnings) lines.push(`- ${warning}`)
          return lines.join('\n')
        } catch (error) {
          return errorText(error)
        }
      },
    }))

    tools.register(defineTool({
      name: 'migrate_inspect',
      description: '查看一个 DSH 配置迁移快照的摘要与 requirement.md 报表（不修改任何东西）。',
      parameters: {
        snapshotDir: { type: 'string' as const, required: true as const, description: '快照目录路径' },
      },
      output: { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
      timeoutMs: 30_000,
      execute: (args: Record<string, any>) => {
        try {
          const reply = this.inspect(args.snapshotDir)
          return `${reply.summary}\n\n${reply.report}`
        } catch (error) {
          return errorText(error)
        }
      },
    }))

    tools.register(defineTool({
      name: 'migrate_restore',
      description: '把配置迁移快照恢复到目标机器上的一个新（空）profile：装插件、写配置、校验生效配置。恢复前先用 dryRun 预览。',
      parameters: {
        snapshotDir: { type: 'string' as const, required: true as const, description: '快照目录路径' },
        targetProfile: { type: 'string' as const, description: '目标 profile 名（默认用快照里的原名）' },
        withHome: { type: 'boolean' as const, description: '同时写入机器级配置层（影响本机所有 profile，需谨慎）' },
        force: { type: 'boolean' as const, description: '机器级配置已存在时备份覆盖' },
        dryRun: { type: 'boolean' as const, description: '只预览计划不执行' },
      },
      output: { schema: { type: 'string' as const }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
      timeoutMs: 600_000,
      execute: (args: Record<string, any>) => {
        try {
          const reply = this.restore({
            snapshotDir: args.snapshotDir,
            targetProfile: typeof args.targetProfile === 'string' ? args.targetProfile : undefined,
            withHome: args.withHome === true,
            force: args.force === true,
            dryRun: args.dryRun === true,
          })
          const lines = [...reply.plan]
          if (reply.installed) {
            lines.push('', `恢复完成: profile ${reply.profile} → ${reply.targetDir}`)
            lines.push(`校验: ${reply.verification}`)
            if (reply.redactionCount > 0) {
              lines.push(`注意: 有 ${reply.redactionCount} 处密钥在导出时被脱敏，需人工补填到 cordis.patch.yml`)
            }
          }
          for (const warning of reply.warnings) lines.push(`- ${warning}`)
          return lines.join('\n')
        } catch (error) {
          return errorText(error)
        }
      },
    }))
  }

  /** Export one or every profile into a new snapshot directory. */
  @Remote('export')
  exportSnapshot(request: ExportRequest): ExportReply {
    const result = exportSnapshot({
      all: request.all,
      profiles: request.profiles,
      outDir: request.outDir,
      noRedact: false,
      includeHome: true,
    })
    writeReport(result.snapshotDir, result.manifest)
    const redactionCount = Object.values(result.manifest.profiles)
      .reduce((sum, profile) => sum + profile.redactions.length, 0) + result.manifest.home.redactions.length
    return {
      snapshotDir: result.snapshotDir,
      profiles: Object.keys(result.manifest.profiles),
      redactionCount,
      warnings: result.warnings.map(warning => `[${warning.kind}] ${warning.message}`),
    }
  }

  /** Read a snapshot's summary and requirement.md without touching anything. */
  @Remote('inspect')
  inspect(snapshotDir: string): InspectReply {
    const manifest = readManifest(snapshotDir)
    let report: string
    try {
      report = readFileSync(join(snapshotDir, REPORT_FILENAME), 'utf8')
    } catch {
      report = renderReport(manifest)
    }
    const summary = `快照: ${snapshotDir}\n来源: dsh ${manifest.source.dshVersion} (${manifest.source.platform})\nprofile: ${Object.keys(manifest.profiles).join(', ')}\n机器级配置: ${manifest.home.included ? '已包含' : '未包含'}`
    return { summary, report }
  }

  /** Restore a snapshot (plan-only when dryRun). Long-running: pnpm install. */
  @Remote('restore')
  restore(request: RestoreRequest): RestoreReply {
    const options: RestoreOptions = {
      snapshotDir: request.snapshotDir,
      targetProfile: request.targetProfile,
      withHome: request.withHome,
      force: request.force,
      dryRun: request.dryRun,
    }
    const report = restoreSnapshot(options)
    let verification: string
    switch (report.verification.status) {
      case 'verified':
        verification = '✅ dump-config 行结构与快照基准一致'
        break
      case 'mismatch':
        verification = `⚠️ 与基准不一致\n${report.verification.detail}`
        break
      case 'skipped':
        verification = `跳过（${report.verification.reason}）`
        break
      default:
        verification = ''
    }
    return {
      installed: report.installed,
      profile: report.profile,
      targetDir: report.targetDir,
      plan: report.plan,
      verification,
      warnings: report.warnings,
      redactionCount: report.redactionCount,
    }
  }
}

export default ConfigMigratorGateway
