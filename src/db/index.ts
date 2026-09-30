export * from './schema';

/**
 * Normalizes an EVM address to lowercase.
 */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
