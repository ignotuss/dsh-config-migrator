import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { dshHomeDisplay, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { PROFILE_TEMPLATES, resolveProfileDir } from "@deepseek-ai/dsh-app-boot";
//#region src/core/manifest.ts
/**
* Snapshot manifest: schema, validation, and disk I/O. The manifest is the
* machine truth a restore reads; requirement.md is only the human report.
* @module dsh-config-migrator/core/manifest
*/
const MANIFEST_FILENAME = "manifest.json";
const SCHEMA_VERSION = 1;
const TOOL_NAME = "dsh-config-migrator";
const TOOL_VERSION = "0.1.0";
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(path, message) {
	throw new Error(`invalid manifest${path}: ${message}`);
}
function expectString(record, key, path) {
	const value = record[key];
	if (typeof value !== "string") fail(path, `"${key}" must be a string`);
	return value;
}
function expectRecord(record, key, path) {
	const value = record[key];
	if (!isRecord(value)) fail(path, `"${key}" must be an object`);
	return value;
}
function expectStringArray(record, key, path) {
	const value = record[key];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(path, `"${key}" must be a string array`);
	return value;
}
function expectRedactions(record, key, path) {
	const value = record[key];
	if (value === void 0) return [];
	if (!Array.isArray(value)) fail(path, `"${key}" must be an array`);
	return value.map((item, index) => {
		if (!isRecord(item)) fail(`${path}.${key}[${index}]`, "must be an object");
		return {
			file: expectString(item, "file", `${path}.${key}[${index}]`),
			line: typeof item.line === "number" && Number.isInteger(item.line) ? item.line : fail(`${path}.${key}[${index}]`, "\"line\" must be an integer"),
			hint: expectString(item, "hint", `${path}.${key}[${index}]`)
		};
	});
}
function expectWarnings(record) {
	const value = record.warnings;
	if (value === void 0) return [];
	if (!Array.isArray(value)) fail(".warnings", "must be an array");
	return value.map((item, index) => {
		if (!isRecord(item)) fail(`.warnings[${index}]`, "must be an object");
		return {
			kind: typeof item.kind === "string" ? item.kind : fail(`.warnings[${index}]`, "\"kind\" must be a string"),
			profile: typeof item.profile === "string" ? item.profile : void 0,
			file: typeof item.file === "string" ? item.file : void 0,
			message: expectString(item, "message", `.warnings[${index}]`)
		};
	});
}
/**
* Validate an unknown JSON value as a v1 snapshot manifest, throwing on the
* first structural problem. Restore must never proceed past this check.
*/
function validateManifest(value) {
	if (!isRecord(value)) throw new Error("invalid manifest: root must be an object");
	if (value.schemaVersion !== 1) throw new Error(`invalid manifest: unsupported schemaVersion ${JSON.stringify(value.schemaVersion)} (this build supports 1)`);
	if (value.tool !== "dsh-config-migrator") throw new Error(`invalid manifest: not a ${TOOL_NAME} snapshot`);
	const createdAt = expectString(value, "createdAt", "");
	const source = expectRecord(value, "source", "");
	const dshVersion = expectString(source, "dshVersion", ".source");
	const platform = expectString(source, "platform", ".source");
	const homeLabel = expectString(source, "homeLabel", ".source");
	const profiles = expectRecord(value, "profiles", "");
	const names = Object.keys(profiles);
	if (names.length === 0) fail(".profiles", "must contain at least one profile");
	const resolvedProfiles = {};
	for (const name of names) {
		if (!isRecord(profiles[name])) fail(`.profiles.${name}`, "must be an object");
		const entry = profiles[name];
		resolvedProfiles[name] = {
			bundles: expectStringArray(entry, "bundles", `.profiles.${name}`),
			dependencies: expectRecord(entry, "dependencies", `.profiles.${name}`),
			patchEntryCount: typeof entry.patchEntryCount === "number" && Number.isInteger(entry.patchEntryCount) ? entry.patchEntryCount : fail(`.profiles.${name}`, "\"patchEntryCount\" must be an integer"),
			composedAvailable: entry.composedAvailable === true,
			redactions: expectRedactions(entry, "redactions", `.profiles.${name}`)
		};
	}
	const home = expectRecord(value, "home", "");
	const resolvedHome = {
		included: home.included === true,
		patchEntryCount: typeof home.patchEntryCount === "number" && Number.isInteger(home.patchEntryCount) ? home.patchEntryCount : fail(".home", "\"patchEntryCount\" must be an integer"),
		redactions: expectRedactions(home, "redactions", ".home")
	};
	return {
		schemaVersion: 1,
		tool: TOOL_NAME,
		toolVersion: expectString(value, "toolVersion", ""),
		createdAt,
		source: {
			dshVersion,
			platform,
			homeLabel
		},
		profiles: resolvedProfiles,
		home: resolvedHome,
		warnings: expectWarnings(value)
	};
}
/** Read and validate a snapshot's manifest.json. */
function readManifest(snapshotDir) {
	const path = join(snapshotDir, MANIFEST_FILENAME);
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const code = error.code;
		throw new Error(`snapshot ${snapshotDir} has no ${MANIFEST_FILENAME}${code === "ENOENT" ? "" : ` (${code})`}`);
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`invalid manifest: ${path} is not valid JSON`);
	}
	return validateManifest(parsed);
}
/** Write a manifest.json into a snapshot directory (created if needed). */
function writeManifest(snapshotDir, manifest) {
	writeFileSync(join(snapshotDir, MANIFEST_FILENAME), JSON.stringify(manifest, void 0, 2) + "\n");
}
/** Count top-level patch rows of a patch file by its raw text (v1 heuristic). */
function countPatchEntries(text) {
	let count = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#") || trimmed === "") continue;
		if (line.startsWith("- ")) count += 1;
	}
	return count;
}
//#endregion
//#region src/core/redact.ts
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
const REDACTED = "<REDACTED>";
const SENSITIVE_WORDS = /* @__PURE__ */ new Set([
	"key",
	"token",
	"secret",
	"password",
	"credential",
	"authorization",
	"passwd"
]);
/**
* A config key that names a secret (camelCase/snake_case/kebab aware).
* "monkey" merely ends in "key" and must NOT match: the sensitive word needs
* a real boundary — standalone, a kebab/snake segment, or a camelCase edge.
*/
function isSensitiveKey(key) {
	if (SENSITIVE_WORDS.has(key.toLowerCase())) return true;
	if (key.includes("_") || key.includes("-")) {
		const segment = key.split(/[_-]/).pop() ?? "";
		if (SENSITIVE_WORDS.has(segment.toLowerCase())) return true;
	}
	for (const word of SENSITIVE_WORDS) {
		const tail = word.charAt(0).toUpperCase() + word.slice(1);
		const tailIndex = key.length - tail.length;
		if (tailIndex > 0 && key.endsWith(tail) && /[a-z0-9]/.test(key.charAt(tailIndex - 1))) return true;
		if (key.length > word.length && key.startsWith(word) && /[A-Z]/.test(key.charAt(word.length))) return true;
	}
	return false;
}
/** YAML block-scalar indicators must never be touched. */
const BLOCK_SCALARS = /* @__PURE__ */ new Set([
	"|",
	">",
	"|-",
	">-",
	"|+",
	">+"
]);
/**
* Redact one line: sensitive-named values first, then secret-shaped values.
* Spans are applied right-to-left so earlier replacements never shift later
* indexes. Comment lines and `!!js`-expression values are left alone; values
* that reference environment variables (`$NAME` / `${NAME}`) are reported,
* not redacted.
*/
function redactLine(raw, lineNumber, state) {
	const trimmed = raw.trimStart();
	if (trimmed === "" || trimmed.startsWith("#")) return raw;
	const spans = [];
	for (const match of raw.matchAll(/[A-Za-z_][\w.-]*(?=\s*:)/g)) {
		const key = match[0];
		if (!isSensitiveKey(key)) continue;
		const afterKey = raw.slice(match.index + key.length);
		const colon = /^\s*:/.exec(afterKey);
		if (colon === null) continue;
		const rest = afterKey.slice(colon[0].length);
		let valueStart = colon[0].length + match.index + key.length;
		let valueEnd = -1;
		let quote;
		const space = /^\s*/.exec(rest);
		if (space !== null) valueStart += space[0].length;
		const head = raw[valueStart];
		if (head === "\"" || head === "'") {
			quote = head;
			const closing = raw.indexOf(head, valueStart + 1);
			if (closing !== -1) valueEnd = closing + 1;
		} else {
			const valueMatch = /^[^\s,#]+/.exec(raw.slice(valueStart));
			if (valueMatch !== null) valueEnd = valueStart + valueMatch[0].length;
		}
		if (valueEnd === -1) continue;
		const value = raw.slice(valueStart, valueEnd);
		const inner = quote === void 0 ? value : value.slice(1, -1);
		if (inner === "" || BLOCK_SCALARS.has(inner)) continue;
		if (inner.startsWith("$")) {
			state.envRefs.push({
				line: lineNumber,
				variable: inner
			});
			continue;
		}
		spans.push({
			start: valueStart,
			end: valueEnd,
			replacement: quote === void 0 ? REDACTED : `${quote}${REDACTED}${quote}`
		});
		state.redactions.push({
			line: lineNumber,
			hint: key
		});
	}
	const working = applySpans(raw, spans);
	const shapePattern = /(?<colon>:\s*)(?<quote>"|')?(?<value>sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9+/]{40,}={0,2}|[A-Fa-f0-9]{32,})(?<close>"|')?/g;
	const shapeSpans = [];
	for (const match of working.matchAll(shapePattern)) {
		const groups = match.groups;
		if (groups.value === "<REDACTED>" || groups.value.startsWith("$")) continue;
		if (groups.quote !== void 0 && groups.close === void 0) continue;
		shapeSpans.push({
			start: (match.index ?? 0) + groups.colon.length,
			end: (match.index ?? 0) + groups.colon.length + (groups.quote !== void 0 ? 1 : 0) + groups.value.length + (groups.close !== void 0 ? 1 : 0),
			replacement: groups.quote !== void 0 ? `${groups.quote}${REDACTED}${groups.quote}` : REDACTED
		});
	}
	for (const span of shapeSpans) state.redactions.push({
		line: lineNumber,
		hint: "疑似密钥值（形态特征）"
	});
	return applySpans(working, shapeSpans);
}
function applySpans(text, spans) {
	if (spans.length === 0) return text;
	const sorted = [...spans].sort((a, b) => b.start - a.start);
	let result = text;
	for (const span of sorted) result = result.slice(0, span.start) + span.replacement + result.slice(span.end);
	return result;
}
/** A `key: |` / `key: >` line opens a multi-line block scalar. */
const BLOCK_START = /^(\s*)[A-Za-z_][\w.-]*\s*:\s*[|>][+-]?\s*(?:#.*)?$/;
/**
* Redact a whole patch file, preserving everything except secret values.
* Lines inside YAML block scalars (`key: |` bodies) are content, not mapping
* entries, and are passed through untouched.
* @returns the redacted text plus redaction locations and env-var references.
*/
function redactPatch(text) {
	const redactions = [];
	const envRefs = [];
	const state = {
		redactions,
		envRefs
	};
	const lines = text.split("\n");
	const out = [];
	let blockIndent = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (blockIndent !== null) {
			const indent = /^\s*/.exec(line)?.[0].length ?? 0;
			if (line.trim() === "" || indent > blockIndent) {
				out.push(line);
				continue;
			}
			blockIndent = null;
		}
		const block = BLOCK_START.exec(line);
		if (block !== null) blockIndent = block[1].length;
		out.push(redactLine(line, index + 1, state));
	}
	return {
		text: out.join("\n"),
		redactions,
		envRefs
	};
}
//#endregion
//#region src/core/pack.ts
/**
* Snapshot export: read a profile directory (or every profile) plus the
* machine-level home layer, copy the declarative truth files byte-faithfully,
* redact secrets, analyze portability, and write the manifest + report.
*
* The engine never boots a cordis tree: everything a snapshot needs is file
* state under $DSH_HOME (see DESIGN.md §3).
* @module dsh-config-migrator/core/pack
*/
/** Profile files a snapshot carries verbatim. */
const PROFILE_FILES = [
	"package.json",
	"cordis.patch.yml",
	"pnpm-workspace.yaml",
	"pnpm-lock.yaml"
];
const HOME_PATCH_FILENAME = "cordis.patch.yml";
const PATCH_FILENAME = "cordis.patch.yml";
/** The dump-config reference a restore diffs against. */
const COMPOSED_FILENAME = "composed-config.yml";
/**
* Default probe: run `dsh --profile <name> --dump-config` (boot-free) to
* capture the composed effective config as the restore verification baseline.
* Injectable so tests and the GUI path can substitute their own.
*/
function spawnDumpConfig(profile) {
	const result = spawnSync("dsh", [
		"--profile",
		profile,
		"--dump-config"
	], {
		encoding: "utf8",
		shell: process.platform === "win32"
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? ""
	};
}
/** Best-effort dsh version for the manifest source record. */
function probeDshVersion() {
	const result = spawnSync("dsh", ["--version"], {
		encoding: "utf8",
		shell: process.platform === "win32"
	});
	const line = (result.stdout ?? "").trim();
	return result.status === 0 && line !== "" ? line : "unknown";
}
/** Flag config values that embed absolute machine paths. */
function scanAbsolutePaths(profile, snapshotFile, content) {
	const warnings = [];
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trimStart().startsWith("#")) continue;
		if (/[A-Za-z]:[\\/]/.test(line) || /(?:^|[^A-Za-z])\/(?:Users|home|var|etc|opt|usr)\//.test(line)) warnings.push({
			kind: "absolute-path",
			profile,
			file: snapshotFile,
			message: `第 ${index + 1} 行疑似包含绝对路径，换机器后需核对`
		});
	}
	return warnings;
}
/**
* Analyze one profile directory, write its truth files (redacted) into the
* snapshot, and return its manifest entry.
*/
function packProfile(home, name, options, probe, snapshotProfilesDir) {
	const dir = resolveProfileDir(name, home);
	if (!existsSync(join(dir, "package.json"))) throw new Error(`profile ${JSON.stringify(name)} does not exist at ${dir}`);
	const targetDir = join(snapshotProfilesDir, name);
	mkdirSync(targetDir, { recursive: true });
	const warnings = [];
	const redactions = [];
	const bundles = [];
	const dependencies = {};
	let patchEntryCount = 0;
	for (const filename of PROFILE_FILES) {
		const path = join(dir, filename);
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf8");
		const snapshotFile = `profiles/${name}/${filename}`;
		if (filename === "package.json") {
			let parsed;
			try {
				parsed = JSON.parse(content);
			} catch {
				throw new Error(`profile ${name}: package.json is not valid JSON`);
			}
			bundles.push(...parsed.dsh?.profile?.bundles ?? []);
			for (const [dep, spec] of Object.entries(parsed.dependencies ?? {})) if (typeof spec === "string") dependencies[dep] = spec;
			writeFileSync(join(targetDir, filename), content);
			continue;
		}
		if (filename === PATCH_FILENAME) {
			patchEntryCount = countPatchEntries(content);
			if (options.noRedact) writeFileSync(join(targetDir, filename), content);
			else {
				const result = redactPatch(content);
				writeFileSync(join(targetDir, filename), result.text);
				redactions.push(...result.redactions.map((item) => ({
					file: snapshotFile,
					line: item.line,
					hint: item.hint
				})));
				for (const ref of result.envRefs) warnings.push({
					kind: "env-reference",
					profile: name,
					file: snapshotFile,
					message: `第 ${ref.line} 行引用了环境变量 ${ref.variable}——快照不包含环境变量，恢复后需在目标机器自行配置`
				});
			}
		} else writeFileSync(join(targetDir, filename), content);
		warnings.push(...scanAbsolutePaths(name, snapshotFile, content));
	}
	for (const [dep, spec] of Object.entries(dependencies)) if (/^(?:file|link|workspace):/.test(spec)) warnings.push({
		kind: "non-registry-dependency",
		profile: name,
		message: `依赖 ${dep} 使用 ${spec} spec，指向导出机器的本地路径，恢复时需人工处理`
	});
	for (const bundle of PROFILE_TEMPLATES[name] ?? []) if (bundles.includes(bundle)) warnings.push({
		kind: "template-bundle",
		profile: name,
		message: `${bundle} 是模板自带 bundle，不由快照安装——目标 DSH 安装必须能提供它`
	});
	let composedAvailable = false;
	const composed = probe(name);
	if (composed.ok) {
		const snapshotFile = `profiles/${name}/${COMPOSED_FILENAME}`;
		if (options.noRedact) writeFileSync(join(targetDir, COMPOSED_FILENAME), composed.stdout);
		else {
			const result = redactPatch(composed.stdout);
			writeFileSync(join(targetDir, COMPOSED_FILENAME), result.text);
			redactions.push(...result.redactions.map((item) => ({
				file: snapshotFile,
				line: item.line,
				hint: item.hint
			})));
		}
		composedAvailable = true;
	}
	return {
		entry: {
			bundles,
			dependencies,
			patchEntryCount,
			composedAvailable,
			redactions
		},
		warnings
	};
}
/** Home layer: always travels with the snapshot; redaction applies equally. */
function packHome(home, options, snapshotHomeDir) {
	const path = join(home, HOME_PATCH_FILENAME);
	if (!existsSync(path)) return {
		entry: {
			included: false,
			patchEntryCount: 0,
			redactions: []
		},
		warnings: []
	};
	const content = readFileSync(path, "utf8");
	mkdirSync(snapshotHomeDir, { recursive: true });
	const snapshotFile = `home/${HOME_PATCH_FILENAME}`;
	const warnings = [];
	const redactions = [];
	if (options.noRedact) writeFileSync(join(snapshotHomeDir, HOME_PATCH_FILENAME), content);
	else {
		const result = redactPatch(content);
		writeFileSync(join(snapshotHomeDir, HOME_PATCH_FILENAME), result.text);
		redactions.push(...result.redactions.map((item) => ({
			file: snapshotFile,
			line: item.line,
			hint: item.hint
		})));
		for (const ref of result.envRefs) warnings.push({
			kind: "env-reference",
			file: snapshotFile,
			message: `第 ${ref.line} 行引用了环境变量 ${ref.variable}——快照不包含环境变量，恢复后需在目标机器自行配置`
		});
	}
	warnings.push(...scanAbsolutePaths(void 0, snapshotFile, content));
	return {
		entry: {
			included: true,
			patchEntryCount: countPatchEntries(content),
			redactions
		},
		warnings
	};
}
/** Profile names under $DSH_HOME/profiles (directories with a manifest). */
function listProfiles(home) {
	const dir = join(home, "profiles");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name !== "node_modules").filter((name) => statSync(join(dir, name)).isDirectory()).filter((name) => existsSync(join(dir, name, "package.json"))).sort();
}
/**
* Export one or every profile into a new snapshot directory under outDir.
*/
function exportSnapshot(options, probe = spawnDumpConfig) {
	const home = resolveDshHome();
	const warnings = [];
	const profileNames = options.all ? listProfiles(home) : options.profiles;
	if (profileNames.length === 0) throw new Error("no profiles to export: pass --profile <name> or --all");
	const scope = options.all ? "all" : profileNames.join("+");
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "");
	const snapshotDir = join(options.outDir, `dsh-migrate-${scope}-${stamp}`);
	mkdirSync(snapshotDir, { recursive: true });
	const profiles = {};
	const profilesDir = join(snapshotDir, "profiles");
	for (const name of profileNames) {
		const result = packProfile(home, name, options, probe, profilesDir);
		profiles[name] = result.entry;
		warnings.push(...result.warnings);
	}
	const homeResult = options.includeHome ? packHome(home, options, join(snapshotDir, "home")) : void 0;
	if (homeResult !== void 0) warnings.push(...homeResult.warnings);
	const manifest = {
		schemaVersion: 1,
		tool: TOOL_NAME,
		toolVersion: TOOL_VERSION,
		createdAt: (/* @__PURE__ */ new Date()).toISOString(),
		source: {
			dshVersion: probeDshVersion(),
			platform: process.platform,
			homeLabel: dshHomeDisplay(home)
		},
		profiles,
		home: homeResult?.entry ?? {
			included: false,
			patchEntryCount: 0,
			redactions: []
		},
		warnings
	};
	writeManifest(snapshotDir, manifest);
	return {
		snapshotDir,
		manifest,
		warnings
	};
}
//#endregion
//#region src/core/report.ts
/**
* requirement.md generation: a human/agent-readable report derived from the
* manifest. Restore never reads it — it is documentation, not truth.
* @module dsh-config-migrator/core/report
*/
const REPORT_FILENAME = "requirement.md";
function section(title, lines) {
	return [
		"",
		`## ${title}`,
		...lines
	];
}
function profileSection(name, manifest) {
	const profile = manifest.profiles[name];
	const lines = [];
	lines.push(`### profile: ${name}`);
	lines.push("", "**插件清单**（包名 → 版本声明，精确版本由 pnpm-lock.yaml 钉死）：", "");
	const deps = Object.entries(profile.dependencies);
	if (deps.length === 0) lines.push("- （无）", "");
	else lines.push(...deps.map(([dep, spec]) => `- \`${dep}\` \`${spec}\``), "");
	lines.push("**加载顺序**（`dsh.profile.bundles`）：", "");
	lines.push(...profile.bundles.length === 0 ? ["- （无）", ""] : profile.bundles.map((bundle) => `1. \`${bundle}\``), "");
	lines.push("**统计**：", "");
	lines.push(`- 插件依赖数：${deps.length}`, `- 补丁行数：${profile.patchEntryCount}`, `- 生效配置基准：${profile.composedAvailable ? "已捕获（composed-config.yml）" : "未捕获（导出时无 dsh 命令）"}`, `- 脱敏数：${profile.redactions.length}`, "");
	return lines;
}
/**
* Render the requirement.md content for a manifest.
*/
function renderReport(manifest) {
	const lines = [];
	lines.push("# DSH 配置迁移快照报表", "");
	lines.push("> 本文件由 `dsh-config-migrator` 自动生成；恢复以 manifest.json 与", "> 快照内的原生文件为准，本报表仅供审阅。", "");
	lines.push("**生成信息**：", "");
	lines.push(`- 生成时间：${manifest.createdAt}`, `- 工具：${manifest.tool}@${manifest.toolVersion}`, `- 来源 DSH 版本：${manifest.source.dshVersion}`, `- 来源平台：${manifest.source.platform}`, `- 来源主目录：${manifest.source.homeLabel}`, "");
	lines.push("**包含的 profile**：", "");
	for (const name of Object.keys(manifest.profiles)) lines.push(`- ${name}`, ...profileSection(name, manifest).map((line) => `  ${line}`));
	lines.push("");
	lines.push(...section("机器级配置层（home/cordis.patch.yml）", [manifest.home.included ? `已包含（补丁行数 ${manifest.home.patchEntryCount}，脱敏 ${manifest.home.redactions.length} 处）。恢复时需要显式确认，且会影响目标机器的所有 profile。` : "未包含。", ""]));
	const redactionLines = [];
	for (const [name, profile] of Object.entries(manifest.profiles)) for (const item of profile.redactions) redactionLines.push(`- \`${item.file}\` 第 ${item.line} 行：${item.hint}`);
	for (const item of manifest.home.redactions) redactionLines.push(`- \`${item.file}\` 第 ${item.line} 行：${item.hint}`);
	lines.push(...section("脱敏清单（恢复后需按此补填密钥）", redactionLines.length > 0 ? redactionLines : ["- （无脱敏内容）"]));
	lines.push("");
	const warningLines = manifest.warnings.length > 0 ? manifest.warnings.map((item) => `- [${item.kind}]${item.profile !== void 0 ? ` (${item.profile})` : ""} ${item.message}`) : ["- （无）"];
	lines.push(...section("可移植性警告", warningLines));
	lines.push("");
	lines.push(...section("恢复操作指引", [
		"1. 在目标机器安装本插件：`dsh plugin --profile <name> add dsh-config-migrator`",
		"2. 预览：`dsh-migrate restore <快照目录> --dry-run`",
		"3. 执行：`dsh-migrate restore <快照目录>`（默认恢复到同名新 profile；机器级配置需 `--with-home`）",
		"4. 按\"脱敏清单\"把真实密钥补填进目标 profile 的 cordis.patch.yml",
		"5. 注意：DSH 会读取分层环境变量，快照不包含环境变量——若某插件密钥来自环境变量，",
		"   需在目标机器自行配置（见上表 env-reference 警告）。",
		""
	]));
	return lines.join("\n");
}
/** Write requirement.md into a snapshot directory. */
function writeReport(snapshotDir, manifest) {
	writeFileSync(join(snapshotDir, REPORT_FILENAME), renderReport(manifest));
}
//#endregion
export { spawnDumpConfig as a, MANIFEST_FILENAME as c, TOOL_VERSION as d, countPatchEntries as f, writeManifest as h, exportSnapshot as i, SCHEMA_VERSION as l, validateManifest as m, renderReport as n, REDACTED as o, readManifest as p, writeReport as r, redactPatch as s, REPORT_FILENAME as t, TOOL_NAME as u };
