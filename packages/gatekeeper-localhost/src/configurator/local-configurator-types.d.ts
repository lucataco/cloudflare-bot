/** Resource picker values, prefilled from a known introduction URL. */
export type LocalConfiguratorValues = { url?: string | null };
/** Owner-scoped URL validation; exposes no file contents or execution authority. */
export interface LocalConfiguratorRpc { resourceUrl(url: string): Promise<string> }
