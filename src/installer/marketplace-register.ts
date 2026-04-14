import { mergeGlobalMarketplace } from './merge-settings.js';

export interface MarketplaceRegisterOptions {
  globalSettingsPath: string;
  marketplaceDir: string;
}

/**
 * Register the claude-sop marketplace directory in global settings.
 * Thin wrapper around mergeGlobalMarketplace for install-verb readability.
 */
export async function registerMarketplace(
  opts: MarketplaceRegisterOptions,
): Promise<void> {
  await mergeGlobalMarketplace(opts.globalSettingsPath, opts.marketplaceDir);
}
