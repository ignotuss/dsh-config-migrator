/**
 * The section component: export / inspect / restore forms over the Remote
 * gateway. Deliberately chrome-light (no CSS modules) so the client bundle
 * needs no extra pipeline.
 */

import { useState } from 'react'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ExportReply, InspectReply, RestoreReply } from '../host/remote'

/** The generated Remote namespace, typed locally from the wire interfaces. */
export interface ConfigMigratorRemote {
  export(request: { all: boolean; profiles: string[]; outDir: string }): Promise<ExportReply>
  inspect(snapshotDir: string): Promise<InspectReply>
  restore(request: {
    snapshotDir: string
    targetProfile?: string
    withHome: boolean
    force: boolean
    dryRun: boolean
  }): Promise<RestoreReply>
}

export interface ConfigMigratorSectionInjected {
  remote: ConfigMigratorRemote
}

export type ConfigMigratorSectionProps = SettingsSectionOwnerProps & ConfigMigratorSectionInjected

const styles: Record<string, React.CSSProperties> = {
  card: { border: '1px solid var(--border-subtle, #333)', borderRadius: 8, padding: 14, marginBottom: 14 },
  title: { margin: '0 0 10px', fontSize: 15, fontWeight: 600 },
  row: { display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' },
  input: { flex: 1, minWidth: 0, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-subtle, #444)', background: 'transparent' },
  button: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--accent, #4a9eff)', color: 'var(--accent, #4a9eff)', background: 'transparent', cursor: 'pointer' },
  pre: { whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 8, maxHeight: 260, overflow: 'auto', background: 'var(--code-bg, #111)', padding: 10, borderRadius: 6 },
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label style={{ flex: 1, minWidth: 0, display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{label}</span>
      <input style={styles.input} value={value} onChange={event => onChange((event.target as HTMLInputElement).value)} />
    </label>
  )
}

export function ConfigMigratorSection({ remote }: ConfigMigratorSectionProps) {
  const [profiles, setProfiles] = useState('')
  const [all, setAll] = useState(false)
  const [outDir, setOutDir] = useState('')
  const [snapshotDir, setSnapshotDir] = useState('')
  const [target, setTarget] = useState('')
  const [withHome, setWithHome] = useState(false)
  const [dryRun, setDryRun] = useState(true)
  const [busy, setBusy] = useState('')
  const [result, setResult] = useState('')

  const run = async (label: string, task: () => Promise<unknown>) => {
    setBusy(label)
    setResult('')
    try {
      const reply = await task()
      setResult(JSON.stringify(reply, null, 2))
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  return (
    <div>
      <div style={styles.card}>
        <h3 style={styles.title}>导出 (Export)</h3>
        <div style={styles.row}>
          <Field label="profile（逗号分隔）" value={profiles} onChange={setProfiles} />
          <label style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} /> 全部
          </label>
        </div>
        <div style={styles.row}>
          <Field label="输出目录" value={outDir} onChange={setOutDir} />
          <button
            style={styles.button}
            disabled={busy !== ''}
            onClick={() => run('导出', () => remote.export({
              all,
              profiles: profiles.split(',').map(item => item.trim()).filter(Boolean),
              outDir: outDir || '.',
            }))}
          >
            导出
          </button>
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.title}>查看 (Inspect)</h3>
        <div style={styles.row}>
          <Field label="快照目录" value={snapshotDir} onChange={setSnapshotDir} />
          <button style={styles.button} disabled={busy !== '' || snapshotDir === ''}
            onClick={() => run('查看', () => remote.inspect(snapshotDir))}>
            查看
          </button>
        </div>
      </div>

      <div style={styles.card}>
        <h3 style={styles.title}>恢复 (Restore)</h3>
        <div style={styles.row}>
          <Field label="快照目录" value={snapshotDir} onChange={setSnapshotDir} />
          <Field label="目标 profile（可选）" value={target} onChange={setTarget} />
        </div>
        <div style={styles.row}>
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={dryRun} onChange={event => setDryRun(event.target.checked)} /> 仅预览 (dry-run)
          </label>
          <label style={{ fontSize: 12 }}>
            <input type="checkbox" checked={withHome} onChange={event => setWithHome(event.target.checked)} /> 写入机器级配置
          </label>
          <button
            style={styles.button}
            disabled={busy !== '' || snapshotDir === ''}
            onClick={() => run('恢复', () => remote.restore({
              snapshotDir,
              targetProfile: target.trim() === '' ? undefined : target.trim(),
              withHome,
              force: false,
              dryRun,
            }))}
          >
            {dryRun ? '预览' : '恢复'}
          </button>
        </div>
      </div>

      {busy !== '' && <p style={{ fontSize: 12 }}>执行中：{busy}（恢复含 pnpm 安装，可能耗时数分钟）</p>}
      {result !== '' && <pre style={styles.pre}>{result}</pre>}
    </div>
  )
}
