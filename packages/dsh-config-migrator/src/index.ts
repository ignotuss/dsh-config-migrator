/**
 * Package entry: the boot-free engine, exported for the CLI and consumers;
 * the DEFAULT export is the host gateway (Remote + agent tools), which is
 * what the DSH loader mounts for the bundle row.
 * @module dsh-config-migrator
 */

export { ConfigMigratorGateway, ConfigMigratorGateway as default } from './host/remote'
export * from './core/manifest'
export * from './core/pack'
export * from './core/pnpm'
export * from './core/redact'
export * from './core/report'
export * from './core/unpack'
export * from './core/verify'
