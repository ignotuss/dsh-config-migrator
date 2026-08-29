/**
 * Host half of the package. The loader unwraps the package's default export,
 * so the Remote gateway class below is the single row surface; it registers
 * the three agent tools in its constructor.
 * @module dsh-config-migrator/host
 */

export { ConfigMigratorGateway, ConfigMigratorGateway as default } from './remote'
export type { ExportReply, ExportRequest, InspectReply, RestoreReply, RestoreRequest } from './remote'
