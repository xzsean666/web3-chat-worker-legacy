export * from './schema';
export * from './chunker';
export * from './batcher';

/**
 * Normalizes an EVM address to lowercase.
 */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}
