import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';

export interface TestWallet {
  account: PrivateKeyAccount;
  address: string;
  privateKey: `0x${string}`;
  signMessage: (message: string) => Promise<`0x${string}`>;
}

export function createTestWallet(): TestWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    address: account.address.toLowerCase(),
    privateKey,
    signMessage: (message: string) => account.signMessage({ message }),
  };
}
