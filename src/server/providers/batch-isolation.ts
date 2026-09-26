import type { ProviderKind } from "./types";

/**
 * Keep an unexpected provider-wide failure from aborting the aggregate sync.
 * Normal connection failures should already be represented by each provider's
 * syncAll(); this is the outer safety boundary for failures before per-
 * connection handling can return (provider construction, connection
 * enumeration, credential bootstrap, etc.).
 *
 * The failure factory is provider-specific so this boundary preserves each
 * provider's public result shape (notably Plaid's legacy itemId field).
 */
export async function isolateProviderBatch<T>(
  provider: ProviderKind,
  run: () => Promise<T[]>,
  failure: (message: string) => T,
): Promise<T[]> {
  try {
    return await run();
  } catch {
    return [failure(`${provider} sync failed before individual connections could be processed.`)];
  }
}
