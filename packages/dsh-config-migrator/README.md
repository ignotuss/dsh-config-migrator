# dsh-config-migrator

Move a DSH (DeepSeek Harness) profile to another machine — plugin set, pinned
versions, load order, parameters, and enabled/disabled state — then verify that
the *effective* configuration matches the source, using a boot-free
`dsh --dump-config` baseline.

> **Status: P1 complete.** CLI + core engine + agent tools + settings-page
> section + typert Remote gateway are implemented and acceptance-tested
> (export a live profile → restore into a fresh `$DSH_HOME` → `--dump-config`
> matches the snapshot baseline row for row). 36 unit tests, no Cordis boot.
>
> **Not yet published to npm.** Install from a local checkout with `link:` for
> now — see [Install](#install).
>
> 中文文档：[README.zh.md](README.zh.md)

---

## Why

A DSH profile is *declarative file state* under `$DSH_HOME`, layered from
template bundles, a profile patch, a machine-level home patch, and CLI
overrides (see `DESIGN.md` §3). Copying a whole `$DSH_HOME` between machines
does not work: it carries boot-generated files, absolute paths, machine
secrets, and store artifacts that belong to the old machine.

`dsh-config-migrator` treats the **truth files** as the unit of transfer, keeps
them byte-faithful, and proves the result:

| Truth file | Carries |
| --- | --- |
| `package.json` | dependencies + `dsh.profile.bundles` (load order) |
| `cordis.patch.yml` | parameters and enable/disable state (line-redacted) |
| `pnpm-workspace.yaml` | workspace layout |
| `pnpm-lock.yaml` | exact versions (including `github:` resolutions) |

`cordis.yml` is boot-generated, so it never travels. Nothing is installed by
guessing: the engine never boots a Cordis tree, so export and restore work on a
machine where DSH cannot even start.

## What it does / does not do

**Does**

- Exports one profile, several, or every profile (`--all`), plus the
  machine-level home layer.
- Redacts secret-looking values **by default** and records each one by file +
  line, so you can refill them precisely after a restore.
- Analyzes portability and reports what will break on the other machine
  (absolute paths, `link:`/`file:` targets, template bundles, env references).
- Restores into a *new, empty* profile: stages files, runs
  `pnpm install --frozen-lockfile`, repairs lockfile-relative links, verifies
  the composed config, and rolls the staged files back if anything fails.

**Does not (v1)**

- Restore into a **non-empty** profile — v1 refuses and suggests a new name
  (merge mode is planned).
- Carry **environment variables**: values that reference `$NAME` are reported,
  never redacted, and must be configured on the target machine.
- Install **template bundles** such as `@deepseek-ai/dsh-base`: the target DSH
  installation must be able to provide them.
- Make a `link:`/`file:` dependency exist on the target machine — the link is
  rebuilt to an absolute path, but the target directory must exist.

## Requirements

- Node.js ≥ 20 (developed on 24.x)
- pnpm 11.x (`packageManager: pnpm@11.7.0`) — used for the restore install
- A DSH installation that provides the `dsh` CLI. Only boot-free subcommands
  are used (`--dump-config`), so no working credentials or plugins are needed
  for export/verify. If `dsh` is not on `PATH`, set `DSH_MIGRATE_DSH`.

## Install

**From npm (once published):**

```sh
dsh plugin --profile <name> add dsh-config-migrator
```

**From a local checkout (works today):**

```sh
# 1. build the package (the bin shim loads lib/, so a build is required)
pnpm install
pnpm build

# 2. link installs need the in-box dev dependencies wired first
node packages/dsh-config-migrator/scripts/link-inbox.mjs <path-to-dsh-checkout>

# 3. link it into a profile, then restart/reload DSH so the roster rescans
dsh plugin --profile <name> add "link:<path-to-repo>/packages/dsh-config-migrator"
```

The bundle patch (`cordis.patch.yml`) registers the three agent tools in the
booted tree and the client bundle adds the settings-page section.

> `@deepseek-ai/dsh-tools` is consumed as an **in-box** package of the DSH
> installation (its transitive dependencies are unpublished), which is what
> `link-inbox.mjs` wires up for linked installs. It also vendors the checkout's
> typert generator (the npm generator release is internally inconsistent with
> the protocol) and junctions the client dev types.
>
> `pnpm install` overwrites those junctions — re-run `link-inbox.mjs` after any
> dependency install.

## Quick start

```sh
# on the old machine
dsh-migrate export --profile web --out ./snapshots

# move ./snapshots/dsh-migrate-web-<stamp> to the new machine, then:
dsh-migrate inspect ./dsh-migrate-web-<stamp>            # read the report
dsh-migrate restore ./dsh-migrate-web-<stamp> --dry-run   # preview the plan
dsh-migrate restore ./dsh-migrate-web-<stamp> --yes       # execute

# finally: refill redacted secrets per manifest.json → redactions
```

## Usage — CLI

```
dsh-migrate export  [--profile <name>]... | --all  [--out <dir>] [--no-redact --yes]
dsh-migrate inspect <snapshot-dir>
dsh-migrate restore <snapshot-dir> [--profile <name>] [--with-home] [--force] [--dry-run] [--yes]
```

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--profile <name>` | export (repeatable) / restore | export: which profile(s); **restore: the destination profile name** (defaults to the snapshot's original name) |
| `--all` | export | export every profile under `$DSH_HOME/profiles` (mutually exclusive with `--profile`) |
| `--out <dir>` | export | snapshot output directory (default: current directory) |
| `--no-redact` | export | keep secrets in plain text; **requires `--yes`** |
| `--with-home` | restore | also write the machine-level config layer |
| `--force` | restore | overwrite an existing home layer (backed up to `.bak-<timestamp>` first) |
| `--dry-run` | restore | print the plan only, change nothing |
| `--yes` | restore | skip the interactive confirmation (required when stdin is not a TTY) |
| `--help`, `-h` | any | print usage |

`export` always captures the machine-level home layer; whether it is *written*
on the target is decided at restore time by `--with-home`.

**Snapshot naming:** `dsh-migrate-<scope>-<UTC stamp>`, where scope is the
profile name (`+`-joined when several) or `all`. The stamp is UTC.

**Restore flow:** print/confirm the plan → stage files → `pnpm install
--frozen-lockfile` → repair `link:`/`file:` deps to absolute targets → write
the home layer (only with `--with-home`) → verify. A failure during install or
verification rolls the staged files back.

**Verification result:** one of

- `✅ dump-config 行结构与快照基准一致（id 集合 + 禁用位）` — the restored profile
  composes to the same row ids and disabled bits as the baseline
- `⚠️ 与基准不一致` plus a diff detail
- `跳过（原因）` — e.g. no `dsh` available, or the snapshot has no
  `composed-config.yml` baseline because export could not run `dsh`

**Exit codes & errors:** argument problems print `dsh-migrate: <message>` plus a
`--help` hint and exit 1; engine errors (e.g. a snapshot without
`manifest.json`) currently surface as a Node stack trace and exit 1.

## Usage — settings page

Installed, the client bundle adds a **Config Migration** section to the DSH
settings page with three cards:

| Card | Fields |
| --- | --- |
| Export | profiles (comma separated), *all* checkbox, output directory |
| Inspect | snapshot directory |
| Restore | snapshot directory, optional target profile, *dry-run* (checked by default), *write machine-level config* |

The reply is rendered as JSON under the card. Two differences from the CLI:
restore is `dryRun` by default, and the UI cannot overwrite an existing home
layer (it always sends `force: false`) — use the CLI or an agent tool for that.

## Usage — agent tools

The bundle registers three tools, so an agent can perform the whole migration:

| Tool | Parameters | Timeout |
| --- | --- | --- |
| `migrate_export` | `all`, `profiles[]`, `outDir` | 120 s |
| `migrate_inspect` | `snapshotDir` (required) | 30 s |
| `migrate_restore` | `snapshotDir` (required), `targetProfile`, `withHome`, `force`, `dryRun` | 600 s |

Agent tools **never** export plaintext secrets (`noRedact` is fixed to false),
and `migrate_export` always includes the home layer. Ask in natural language —
"export my `web` profile, then restore it as `fresh-copy` on this machine" —
and the model drives the three calls, reading redaction/warning counts and the
verification verdict from each reply.

## What a snapshot contains

```
dsh-migrate-web-20260927083636/
├── manifest.json              machine-readable index (the restore address book)
├── requirement.md             human-readable report: plugin list, load order,
│                              statistics, redaction list, warnings, how-to
├── home/cordis.patch.yml      machine-level layer
└── profiles/web/
    ├── package.json           dependencies + dsh.profile.bundles
    ├── cordis.patch.yml       parameters / enable-disable state (redacted)
    ├── pnpm-workspace.yaml
    ├── pnpm-lock.yaml         exact versions
    └── composed-config.yml    `dsh --profile web --dump-config` baseline
```

`manifest.json` records the source (`dshVersion`, `platform`, `homeLabel`), per
profile the `bundles` load order, `dependencies`, `patchEntryCount`,
`composedAvailable`, the `redactions` list, the home layer state, and every
`warnings` entry.

`requirement.md` is generated for humans and agents and is **never parsed** by
a restore: the native files plus `manifest.json` are the truth.

## Secrets

Redaction runs per line and is conservative, so comments, `!!js` expressions,
YAML block scalars, and byte-level ordering survive untouched.

- **Sensitive keys** — `key`, `token`, `secret`, `password`, `credential`,
  `authorization`, `passwd` as a standalone key, a `snake_case`/`kebab-case`
  segment, or a camelCase edge (`apiKey`, `api_key`, `api-key`). Boundary-aware
  matching means `monkey` is *not* redacted.
- **Secret shapes** — `sk-…`, `gh[pousr]_…`, `github_pat_…`, JWTs
  (`eyJ….….…`), base64 ≥ 40 chars, hex ≥ 32 chars.
- **Environment references** — `$NAME` / `${NAME}` are reported as
  `env-reference` warnings and never redacted, because a snapshot cannot carry
  environment variables.
- Each redaction is recorded in `manifest.json` as **file + line**, so refilling
  after a restore is mechanical. A restore with redactions tells you the count.
- `--no-redact --yes` (CLI only) writes plaintext secrets into the snapshot.
  **Never share such a snapshot.** Agent tools cannot do this.

## Portability warnings

| Kind | Means |
| --- | --- |
| `absolute-path` | a patch line contains a machine-specific path |
| `non-registry-dependency` | a dependency uses a `link:`/`file:` spec pointing at the source machine |
| `stale-link-target` | a lockfile link no longer resolves; the link is repaired at restore |
| `template-bundle` | a bundle is provided by the DSH installation (e.g. `@deepseek-ai/dsh-base`), not installed from the snapshot |
| `env-reference` | a value reads an environment variable; configure it on the target |

Example from a real export:

```
- [absolute-path] profiles/web/cordis.patch.yml 第 16 行疑似包含绝对路径，换机器后需核对
- [non-registry-dependency] (web) 依赖 dsh-vision-router 使用 link:C:/Users/…/dsh-vision-router spec
- [template-bundle] (web) @deepseek-ai/dsh-base 是模板自带 bundle，不由快照安装
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `dsh-migrate: build output missing — run pnpm build` | run `pnpm build` in the package |
| `Cannot find package 'tsx'` or missing deps in a linked install | `pnpm install`, then re-run `node scripts/link-inbox.mjs <checkout>` |
| verification reports `跳过` | set `DSH_MIGRATE_DSH` to the `dsh` bin so the baseline can be captured and checked |
| restore refuses the target | v1 only restores empty profiles — pass `--profile <new-name>` |
| home layer already exists | re-run with `--force` (the old layer is backed up to `.bak-<timestamp>`) |
| Windows `link:C://Users//…` spec in warnings | a doubly-escaped link written by an earlier install; fix it in the snapshot's `package.json` before restoring elsewhere |

## Development

```sh
pnpm install
node packages/dsh-config-migrator/scripts/link-inbox.mjs <path-to-dsh-checkout>
pnpm build       # protocol package (tsc) + plugin package (tsdown) + client bundle
pnpm test        # node:test + tsx, no boot required (36 tests)
pnpm typecheck
```

Repository layout: this package plus `packages/dsh-typert-protocol` (a vendored
copy of the DSH Remote protocol, so `./typert` and `./remote` resolve without
depending on a published protocol release).

## Docs

- `DESIGN.md` — full design: file model, layering, decisions, open questions
- `docs/architecture.html` (repository root, i.e. `../../docs/architecture.html`
  from this package) — self-contained interactive architecture diagram with
  source evidence pinned to this repository
- `README.zh.md` — 中文文档

## License

MIT
