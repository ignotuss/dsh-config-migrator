/**
 * pnpm orchestration for restore: run pnpm inside the target profile
 * directory, mirroring the mature patterns of `dsh plugin`
 * (apps/cli/src/plugin.ts): .cmd shim via shell on Windows, ENOENT → 127,
 * allowBuilds guidance for blocked git-dependency builds.
 * @module dsh-config-migrator/core/pnpm
 */

import { spawnSync } from 'node:child_process'

export interface PnpmResult {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface PnpmOptions {
  cwd: string
  /** Extra args appended after the pnpm command (default: none). */
  extraArgs?: readonly string[]
  /** When false, stdio streams through to the caller instead of being captured. */
  capture?: boolean
}

const PNPM_NOT_FOUND = `pnpm not found on PATH — install pnpm to restore profile plugins
  (https://pnpm.io/installation)`

/**
 * Run `pnpm <args>` in the profile directory. Profile names are validated
 * upstream; other args are built from validated snapshot data or fixed
 * literals, never raw user input — hence the single command string required
 * by shell-mode spawnSync (DEP0190-safe).
 */
export function runPnpm(args: readonly string[], options: PnpmOptions): PnpmResult {
  const extra = options.extraArgs ?? []
  const command = `pnpm ${[...args, ...extra].join(' ')}`
  const result = spawnSync(command, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.capture === false ? 'inherit' : 'pipe',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, exitCode: 127, stdout: '', stderr: PNPM_NOT_FOUND }
    // A process-start failure is an install failure, not a gateway exception.
    // Keep it inside the PnpmResult contract so restoreSnapshot can execute
    // its staged-file rollback path. This matters on Windows where a denied
    // cmd.exe spawn can surface as EPERM before pnpm gets a chance to run.
    return {
      ok: false,
      exitCode: null,
      stdout: result.stdout ?? '',
      stderr: `pnpm 启动失败${code ? `（${code}）` : ''}: ${result.error.message}`,
    }
  }
  return { ok: result.status === 0, exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** pnpm reported success but warned that it blocked build scripts. */
export function blockedBuilds(result: PnpmResult): boolean {
  return /ignored build scripts|approve-builds/i.test(result.stdout + result.stderr)
}

/** Guidance when a git-hosted dependency's prepare script was blocked. */
export function allowBuildsHint(profileDir: string): string {
  return `pnpm 拦截了某依赖的构建脚本——按 pnpm 输出中的包名，在 ${profileDir} 的 pnpm-workspace.yaml 的 allowBuilds 下放行后重试`
}
