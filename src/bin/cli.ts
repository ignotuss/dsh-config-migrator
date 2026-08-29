/**
 * dsh-migrate CLI: export / inspect / restore for DSH config snapshots.
 * Hand-rolled parsing keeps the engine dependency-light; the surface is
 * deliberately small (DESIGN.md §8.1).
 * @module dsh-config-migrator/bin
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { readManifest } from '../core/manifest'
import { exportSnapshot } from '../core/pack'
import { REPORT_FILENAME, renderReport, writeReport } from '../core/report'
import { restoreSnapshot, type RestoreReport } from '../core/unpack'

const HELP = `dsh-migrate — export / restore DSH profile configuration snapshots

Usage:
  dsh-migrate export  [--profile <name>]... | --all  [--out <dir>] [--no-redact --yes]
  dsh-migrate inspect <snapshot-dir>
  dsh-migrate restore <snapshot-dir> [--profile <name>] [--with-home] [--force] [--dry-run] [--yes]

Commands:
  export   打包 profile（插件清单 + 参数配置 + 机器级配置层）为可移植快照
  inspect  查看快照摘要与 requirement.md 报表
  restore  恢复到目标机器上的一个新（空）profile

Options:
  --profile <name>   指定 profile（export 可重复；restore 为目标名，默认用原名）
  --all              导出 $DSH_HOME/profiles 下的全部 profile
  --out <dir>        快照输出目录（默认当前目录）
  --no-redact        不脱敏密钥（快照将明文包含密钥，必须同时给 --yes）
  --with-home        恢复时写入机器级配置层（影响目标机器所有 profile）
  --force            机器级配置层已存在时备份覆盖
  --dry-run          只预览不执行
  --yes              跳过交互确认
`

interface Args {
  command: 'export' | 'inspect' | 'restore'
  positional: string[]
  flags: Record<string, string[] | boolean>
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags: Record<string, string[] | boolean> = {}
  let command: Args['command'] | undefined
  const commands: readonly Args['command'][] = ['export', 'inspect', 'restore']
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (commands.includes(token as Args['command']) && command === undefined) {
      command = token as Args['command']
    } else if (token.startsWith('--')) {
      const name = token.slice(2)
      if (index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) {
        const existing = flags[name]
        if (Array.isArray(existing)) existing.push(argv[index + 1]!)
        else flags[name] = [argv[index + 1]!]
        index += 1
      } else {
        flags[name] = true
      }
    } else {
      positional.push(token)
    }
  }
  if (command === undefined) {
    console.error(HELP)
    process.exit(1)
  }
  return { command, positional, flags }
}

function flagValues(flags: Args['flags'], name: string): string[] {
  const value = flags[name]
  return Array.isArray(value) ? value : []
}

function hasFlag(flags: Args['flags'], name: string): boolean {
  return flags[name] !== undefined
}

function fail(message: string): never {
  console.error(`dsh-migrate: ${message}`)
  console.error('run `dsh-migrate --help` for usage')
  process.exit(1)
}

function summaryLine(label: string, value: string | number): string {
  return `  ${label}: ${value}`
}

function totalRedactions(manifest: ReturnType<typeof readManifest>): number {
  return Object.values(manifest.profiles).reduce((sum, profile) => sum + profile.redactions.length, 0)
    + manifest.home.redactions.length
}

async function runExport(flags: Args['flags'], positional: string[]): Promise<void> {
  if (positional.length > 0) fail('export takes no positional arguments')
  const profiles = flagValues(flags, 'profile')
  const all = hasFlag(flags, 'all')
  const outDir = flagValues(flags, 'out')[0] ?? process.cwd()
  const noRedact = hasFlag(flags, 'no-redact')
  const yes = hasFlag(flags, 'yes')

  if (all && profiles.length > 0) fail('--all and --profile are mutually exclusive')
  if (!all && profiles.length === 0) fail('export needs --profile <name> or --all')
  if (noRedact && !yes) fail('--no-redact writes secrets in plain text; confirm with --yes')

  if (noRedact) console.error('warning: 快照将明文包含密钥，请妥善保管\n')
  const result = exportSnapshot({ all, profiles, outDir, noRedact, includeHome: true })
  writeReport(result.snapshotDir, result.manifest)

  console.log('快照已生成:')
  console.log(summaryLine('目录', result.snapshotDir))
  console.log(summaryLine('profile 数', Object.keys(result.manifest.profiles).length))
  console.log(summaryLine('脱敏处数', totalRedactions(result.manifest)))
  console.log(summaryLine('警告数', result.warnings.length))
  console.log(summaryLine('报表', join(result.snapshotDir, REPORT_FILENAME)))
  if (result.warnings.length > 0) {
    console.log('\n警告:')
    for (const warning of result.warnings) {
      const where = warning.file !== undefined ? ` ${warning.file}` : warning.profile !== undefined ? ` (${warning.profile})` : ''
      console.log(`  - [${warning.kind}]${where} ${warning.message}`)
    }
  }
}

async function runInspect(snapshotDir: string): Promise<void> {
  const manifest = readManifest(snapshotDir)
  const reportPath = join(snapshotDir, REPORT_FILENAME)
  let report: string
  try {
    report = readFileSync(reportPath, 'utf8')
  } catch {
    report = renderReport(manifest)
  }
  console.log(`快照: ${snapshotDir}`)
  console.log(summaryLine('来源', `dsh ${manifest.source.dshVersion} (${manifest.source.platform}, ${manifest.source.homeLabel})`))
  console.log(summaryLine('profile', Object.keys(manifest.profiles).join(', ')))
  console.log(summaryLine('机器级配置', manifest.home.included ? '已包含' : '未包含'))
  console.log(summaryLine('脱敏处数', totalRedactions(manifest)))
  console.log(summaryLine('警告数', manifest.warnings.length))
  console.log('\n--- requirement.md ---\n')
  console.log(report)
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    fail(`${message} —— 非交互环境请显式加 --yes`)
  }
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await readline.question(message)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

function printReport(report: RestoreReport): void {
  console.log(report.plan.join('\n'))
  if (!report.installed) return
  console.log(`\n恢复完成: profile ${report.profile} → ${report.targetDir}`)
  if (report.homeWritten) console.log('机器级配置已写入' + (report.homeBackedUpTo !== undefined ? `（原文件备份到 ${report.homeBackedUpTo}）` : ''))
  switch (report.verification.status) {
    case 'verified':
      console.log('校验: ✅ dump-config 行结构与快照基准一致（id 集合 + 禁用位）')
      break
    case 'mismatch':
      console.log(`校验: ⚠️ 与基准不一致\n${report.verification.detail}`)
      break
    case 'skipped':
      console.log(`校验: 跳过（${report.verification.reason}）`)
      break
    default:
      break
  }
  if (report.redactionCount > 0) {
    console.log(`\n⚠️ 有 ${report.redactionCount} 处密钥在导出时被脱敏，请按 manifest.json 的 redactions 清单把真实值补填进 cordis.patch.yml`)
  }
  for (const warning of report.warnings) console.log(`  - ${warning}`)
}

async function runRestore(flags: Args['flags'], positional: string[]): Promise<void> {
  if (positional.length !== 1) fail('restore needs exactly one <snapshot-dir>')
  const options = {
    snapshotDir: positional[0]!,
    targetProfile: flagValues(flags, 'profile')[0],
    withHome: hasFlag(flags, 'with-home'),
    force: hasFlag(flags, 'force'),
    dryRun: hasFlag(flags, 'dry-run'),
  }
  const yes = hasFlag(flags, 'yes')
  if (!options.dryRun && !yes) {
    printReport(restoreSnapshot({ ...options, dryRun: true }))
    const answer = await confirm('确认执行恢复？[y/N] ')
    if (!answer) {
      console.log('已取消。')
      return
    }
  }
  printReport(restoreSnapshot(options))
}

export async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP)
    return
  }
  const { command, positional, flags } = parseArgs(process.argv.slice(2))
  switch (command) {
    case 'export': {
      await runExport(flags, positional)
      break
    }
    case 'inspect': {
      if (positional.length !== 1) fail('inspect needs exactly one <snapshot-dir>')
      await runInspect(positional[0]!)
      break
    }
    case 'restore': {
      await runRestore(flags, positional)
      break
    }
    default:
      fail(`unknown command ${command}`)
  }
}
