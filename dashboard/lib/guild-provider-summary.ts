import "server-only";

import { prisma } from "@/lib/prisma";
import { getBotProviders } from "@/lib/settings-catalog";
import type { ProviderSummary } from "@/lib/types";

type EnabledRow = { guild_id: string; provider_id: string; enabled: boolean | number | bigint | null };
const SUMMARY_BATCH_SIZE = 250;

/** Pass only guild IDs already filtered through dashboard membership/access checks. */
export async function getVisibleGuildProviderSummaries(authorizedGuildIds: readonly string[]): Promise<Map<string, ProviderSummary>> {
  const ids = [...new Set(authorizedGuildIds)].filter(Boolean);
  const summaries = new Map<string, ProviderSummary>();
  if (!ids.length) return summaries;
  const providers = getBotProviders();
  const defaults = new Map(providers.map(provider => [provider.id, provider.enabledByDefault === true]));
  const defaultEnabled = [...defaults.values()].filter(Boolean).length;
  for (const id of ids) summaries.set(id, { enabled: defaultEnabled, disabled: providers.length - defaultEnabled, total: providers.length });
  if (!providers.length) return summaries;
  const providerIds = providers.map(provider => provider.id);
  for (let offset = 0; offset < ids.length; offset += SUMMARY_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + SUMMARY_BATCH_SIZE);
    const rows = await prisma.$queryRawUnsafe<EnabledRow[]>(
      `SELECT guild_id, provider_id, enabled FROM guild_provider_settings WHERE guild_id IN (${batch.map(() => "?").join(", ")}) AND provider_id IN (${providerIds.map(() => "?").join(", ")})`,
      ...batch, ...providerIds,
    );
    for (const row of rows) {
      const summary = summaries.get(String(row.guild_id));
      const inherited = defaults.get(row.provider_id);
      if (!summary || inherited === undefined || row.enabled === null || row.enabled === undefined) continue;
      const enabled = row.enabled === true || row.enabled === 1 || row.enabled === BigInt(1);
      summary.enabled += Number(enabled) - Number(inherited);
      summary.disabled = summary.total - summary.enabled;
    }
  }
  return summaries;
}
