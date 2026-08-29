//#region src/core/manifest.d.ts
/**
 * Snapshot manifest: schema, validation, and disk I/O. The manifest is the
 * machine truth a restore reads; requirement.md is only the human report.
 * @module dsh-config-migrator/core/manifest
 */
declare const MANIFEST_FILENAME = "manifest.json";
declare const SCHEMA_VERSION = 1;
declare const TOOL_NAME = "dsh-config-migrator";
declare const TOOL_VERSION = "0.1.0";
/** One redacted secret, located by file + 1-based line inside the snapshot. */
interface ManifestRedaction {
  file: string;
  line: number;
  hint: string;
}
interface ManifestWarning {
  kind: 'absolute-path' | 'non-registry-dependency' | 'template-bundle' | 'env-reference' | string;
  profile?: string;
  file?: string;
  message: string;
}
interface ManifestProfile {
  /** Layer stack order from `dsh.profile.bundles`. */
  bundles: string[];
  /** Installed plugin packages from `dependencies`. */
  dependencies: Record<string, string>;
  /** Top-level patch row count of this profile's cordis.patch.yml. */
  patchEntryCount: number;
  /** Whether `dsh --dump-config` was captured as composed-config.yml. */
  composedAvailable: boolean;
  redactions: ManifestRedaction[];
}
interface ManifestHome {
  included: boolean;
  patchEntryCount: number;
  redactions: ManifestRedaction[];
}
interface Manifest {
  schemaVersion: typeof SCHEMA_VERSION;
  tool: typeof TOOL_NAME;
  toolVersion: string;
  createdAt: string;
  source: {
    /** Best-effort; `unknown` when the dsh binary could not be asked. */
    dshVersion: string;
    platform: string;
    /** Symbolic label only (e.g. `~/.dsh` or `$DSH_HOME`) — never an absolute machine path. */
    homeLabel: string;
  };
  profiles: Record<string, ManifestProfile>;
  home: ManifestHome;
  warnings: ManifestWarning[];
}
/**
 * Validate an unknown JSON value as a v1 snapshot manifest, throwing on the
 * first structural problem. Restore must never proceed past this check.
 */
declare function validateManifest(value: unknown): Manifest;
/** Read and validate a snapshot's manifest.json. */
declare function readManifest(snapshotDir: string): Manifest;
/** Write a manifest.json into a snapshot directory (created if needed). */
declare function writeManifest(snapshotDir: string, manifest: Manifest): void;
/** Count top-level patch rows of a patch file by its raw text (v1 heuristic). */
declare function countPatchEntries(text: string): number;
//#endregion
//#region src/core/pack.d.ts
interface ExportOptions {
  /** `true` = every profile under $DSH_HOME/profiles; else `profiles` names. */
  all: boolean;
  profiles: string[];
  /** Output parent directory (the snapshot dir is created inside it). */
  outDir: string;
  /** Disable redaction (CLI --no-redact, with a loud warning). */
  noRedact: boolean;
  /** Include the machine-level home patch layer. Defaults to true. */
  includeHome: boolean;
}
interface ExportResult {
  snapshotDir: string;
  manifest: Manifest;
  warnings: ManifestWarning[];
}
interface DshProbe {
  (profile: string): {
    ok: boolean;
    stdout: string;
    stderr: string;
  };
}
/**
 * Default probe: run `dsh --profile <name> --dump-config` (boot-free) to
 * capture the composed effective config as the restore verification baseline.
 * Injectable so tests and the GUI path can substitute their own.
 */
declare function spawnDumpConfig(profile: string): {
  ok: boolean;
  stdout: string;
  stderr: string;
};
/**
 * Export one or every profile into a new snapshot directory under outDir.
 */
declare function exportSnapshot(options: ExportOptions, probe?: DshProbe): ExportResult;
//#endregion
//#region src/core/redact.d.ts
/**
 * Conservative line-based secret redaction for patch YAML files.
 *
 * Line-based (not AST-based) on purpose: a full parse would drop comments,
 * `!!js` expressions, and ordering that must round-trip byte-faithfully, and
 * v1 only ever needs to blank string scalars. Redactions are located by
 * 1-based line for the same reason — no JSON pointers on a document we never
 * re-serialized.
 * @module dsh-config-migrator/core/redact
 */
declare const REDACTED = "<REDACTED>";
interface Redaction {
  line: number;
  hint: string;
}
interface EnvReference {
  line: number;
  variable: string;
}
interface RedactResult {
  text: string;
  redactions: Redaction[];
  /** Values that reference environment variables — never redacted, always flagged. */
  envRefs: EnvReference[];
}
/**
 * Redact a whole patch file, preserving everything except secret values.
 * Lines inside YAML block scalars (`key: |` bodies) are content, not mapping
 * entries, and are passed through untouched.
 * @returns the redacted text plus redaction locations and env-var references.
 */
declare function redactPatch(text: string): RedactResult;
//#endregion
//#region src/core/report.d.ts
declare const REPORT_FILENAME = "requirement.md";
/**
 * Render the requirement.md content for a manifest.
 */
declare function renderReport(manifest: Manifest): string;
/** Write requirement.md into a snapshot directory. */
declare function writeReport(snapshotDir: string, manifest: Manifest): void;
//#endregion
export { DshProbe, EnvReference, ExportOptions, ExportResult, MANIFEST_FILENAME, Manifest, ManifestHome, ManifestProfile, ManifestRedaction, ManifestWarning, REDACTED, REPORT_FILENAME, RedactResult, Redaction, SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION, countPatchEntries, exportSnapshot, readManifest, redactPatch, renderReport, spawnDumpConfig, validateManifest, writeManifest, writeReport };