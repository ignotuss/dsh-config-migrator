/**
 * Local type shims for the in-box DSH packages this plugin consumes at
 * runtime but cannot install from the registry: `@deepseek-ai/dsh-tools`
 * (its transitive dependency `dsh-type-meta` is unpublished, so a registry
 * install would fail) is provided by the DSH installation itself — the
 * profile module fallback resolves it — and is declared as an OPTIONAL peer
 * dependency. This file supplies compile-time types only; the runtime ABI
 * (defineTool + ctx.tools.register) mirrors the real package exactly.
 */

declare module '@deepseek-ai/dsh-tools' {
  /** Minimal structural view of the real defineTool definition surface. */
  export function defineTool(definition: {
    name: string
    description: string
    parameters: Record<string, unknown>
    output?: unknown
    timeoutMs?: number
    execute: (args: Record<string, any>, exec?: unknown) => string | Promise<string>
  }): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by the in-box `@deepseek-ai/dsh-tools` plugin at runtime. */
    tools: {
      register(definition: unknown): () => void
    }
  }
}
