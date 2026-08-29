/**
 * Client half: the "配置迁移 (Config Migration)" settings section. Registers
 * one `settings.section` entry and drives the host engine through the
 * generated Remote gateway (ctx.remote.configMigrator).
 * @module dsh-config-migrator/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot contract, the slots/locale Context merges,
// and the api-remotes Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ConfigMigratorSection } from './ConfigMigratorSection'
import type { ConfigMigratorRemote } from './ConfigMigratorSection'
import { en, zh } from './locales'

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.config-migrator'

/** Required services (browser fiber inject). */
export const inject = ['slots', 'locale', 'remote']

/**
 * Mount the settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS as unknown as 'common') as unknown as (key: string) => string
  ctx.effect(() => ctx.locale.register(NS as unknown as 'common', { zh, en } as never), 'config-migrator: section dictionaries')

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'config-migrator',
    order: 16,
    label: () => t('nav'),
    // The published slots types only know in-box locale namespaces; the
    // runtime accepts any registered namespace.
    locale: NS as unknown as 'common',
    inject: () => ({
      remote: (ctx.remote as unknown as { configMigrator: ConfigMigratorRemote }).configMigrator,
    }),
  }, ConfigMigratorSection))
}
