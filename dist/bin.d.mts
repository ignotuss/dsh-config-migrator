//#region src/bin/cli.d.ts
/**
 * dsh-migrate CLI: export / inspect / restore for DSH config snapshots.
 * Hand-rolled parsing keeps the engine dependency-light; the surface is
 * deliberately small (DESIGN.md §8.1).
 * @module dsh-config-migrator/bin
 */
declare function main(): Promise<void>;
//#endregion
export { main };