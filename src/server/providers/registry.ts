import type { FinancialProvider, ProviderKind } from "./types";

const providers = new Map<ProviderKind, FinancialProvider>();

export function registerProvider(provider: FinancialProvider): void {
  if (providers.has(provider.descriptor.kind)) {
    throw new Error(`Provider already registered: ${provider.descriptor.kind}`);
  }
  providers.set(provider.descriptor.kind, provider);
}

export function getProvider(kind: ProviderKind): FinancialProvider {
  const provider = providers.get(kind);
  if (!provider) throw new Error(`Provider is not registered: ${kind}`);
  return provider;
}

export function listProviders(): FinancialProvider[] {
  return [...providers.values()];
}
