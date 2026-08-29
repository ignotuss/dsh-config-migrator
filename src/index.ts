/**
 * Package entry: the boot-free engine, exported for the CLI, the host half
 * (RPC + agent tools), and the settings UI. No cordis imports here.
 * @module dsh-config-migrator
 */

export * from './core/manifest'
export * from './core/pack'
export * from './core/pnpm'
export * from './core/redact'
export * from './core/report'
export * from './core/unpack'
export * from './core/verify'
export { name, inject, apply } from './host'
