# dsh-config-migrator

Export a DSH profile's plugins and configuration as a portable snapshot, and
restore it on a fresh DSH instance — plugin set, pinned versions, load order,
parameters, and enabled/disabled state, verified against a boot-free
`dsh --dump-config` baseline.

> **Status: P1.** CLI + engine + agent tools are implemented and
> acceptance-tested (export the live profile → restore into a fresh
> `$DSH_HOME` → `--dump-config` matches the baseline row-for-row). The
> settings-UI section and the typert Remote gateway are planned for P2.

## How it works

A DSH profile is declarative file state under `$DSH_HOME` (see `DESIGN.md` §3).
The engine never boots a Cordis tree:

- **Export** copies the truth files byte-faithfully
  (`package.json`, `cordis.patch.yml`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`),
  captures the composed effective config via boot-free
  `dsh --profile <name> --dump-config`, redacts secret-shaped values
  conservatively, analyzes portability, and writes `manifest.json` +
  a human-readable `requirement.md` report.
- **Restore** rebuilds a NEW (empty) profile on the target machine: stages the
  files, runs `pnpm install --frozen-lockfile` (exact versions), repairs
  lockfile-relative `link:`/`file:` dependencies to their absolute targets,
  optionally writes the machine-level home layer (explicit `--with-home`),
  and verifies the composed config against the snapshot baseline.

## Install

```sh
dsh plugin --profile <name> add dsh-config-migrator
```

The package's bundle patch registers the three agent tools
(`migrate_export`, `migrate_inspect`, `migrate_restore`) in the booted tree,
so an agent can drive the whole migration for you.

> `@deepseek-ai/dsh-tools` is consumed as an in-box package of the DSH
> installation (not installed from the registry — its transitive dependencies
> are unpublished). For **linked** development installs, junction it from your
> DSH checkout first:
> `node scripts/link-inbox.mjs <path-to-dsh-checkout>`.

## CLI

```sh
# Export one profile (or --all) plus the machine-level layer
dsh-migrate export --profile web
dsh-migrate export --all --out ./snapshots

# Read a snapshot without touching anything
dsh-migrate inspect <snapshot-dir>

# Restore with a preview first
dsh-migrate restore <snapshot-dir> --dry-run
dsh-migrate restore <snapshot-dir> --yes                # same profile name
dsh-migrate restore <snapshot-dir> --profile fresh-copy --with-home --yes
```

- v1 restores **empty profiles only** (a new profile on the new machine — no
  conflicts by construction). Merge mode is planned for P2.
- The machine-level home layer affects **every** profile on the machine, so
  `--with-home` is explicit and an existing layer requires `--force`
  (backed up to `.bak-<timestamp>` first).
- If `dsh` is not on `PATH`, set `DSH_MIGRATE_DSH` to the dsh bin
  (used for the version probe and the composed-config capture/verification).

## Secrets

Export redacts secret-looking values by default (sensitive field names,
`sk-`/`ghp_`/JWT/long-hex shapes), located by file + line in `manifest.json`.
After a restore, fill the real values back into the target profile's
`cordis.patch.yml` per the redaction list. Values that reference environment
variables (`$NAME`) are never redacted — the snapshot cannot carry env vars,
so configure those on the target machine (reported as `env-reference`
warnings). CLI-only `--no-redact --yes` writes plaintext secrets; agent tools
never do.

## Development

```sh
pnpm install
pnpm test        # node:test + tsx, no boot required
pnpm build       # tsdown (lib/*.js) + tsc (lib/types/*.d.ts)
pnpm typecheck
```

Full design: `DESIGN.md`. License: MIT.
