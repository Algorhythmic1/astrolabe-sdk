import {
  Address,
  createSolanaRpc,
  getProgramDerivedAddress,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { fetchSettings } from '../clients/js/src/generated/accounts/settings';
import { ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS } from '../clients/js/src/generated/programs';

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

/**
 * Derives a transaction PDA from settings address and transaction index
 */
export async function deriveTransactionPda(settingsAddress: Address, transactionIndex: bigint): Promise<Address> {
  const [transactionPda] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
      new Uint8Array(Buffer.from('smart_account')),
      bs58.decode(settingsAddress),
      new Uint8Array(Buffer.from('transaction')),
      new Uint8Array(new BigUint64Array([transactionIndex]).buffer),
    ],
  });
  return transactionPda;
}

/**
 * Derives a proposal PDA from settings address and transaction index
 */
export async function deriveProposalPda(settingsAddress: Address, transactionIndex: bigint): Promise<Address> {
  const [proposalPda] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
      new Uint8Array(Buffer.from('smart_account')),
      bs58.decode(settingsAddress),
      new Uint8Array(Buffer.from('transaction')),
      new Uint8Array(new BigUint64Array([transactionIndex]).buffer),
      new Uint8Array(Buffer.from('proposal')),
    ],
  });
  return proposalPda;
}

/**
 * Fetches smart account settings and returns current and next transaction indices
 */
export async function fetchSmartAccountSettings(rpc: SolanaRpc, settingsAddress: Address) {
  const settings = await fetchSettings(rpc, settingsAddress);
  return {
    currentTransactionIndex: settings.data.transactionIndex,
    nextTransactionIndex: settings.data.transactionIndex + 1n,
    threshold: settings.data.threshold
  };
}

/**
 * Decodes a compiled transaction message to extract accounts and instructions
 */
export function decodeTransactionMessage(messageBytes: Uint8Array) {
  return getCompiledTransactionMessageDecoder().decode(messageBytes);
}

/**
 * Derives smart account PDA and related info from a settings address
 */
export async function deriveSmartAccountInfo(
  rpc: SolanaRpc,
  settingsAddress: Address,
  accountIndex?: bigint
): Promise<{
  smartAccountPda: Address;
  settingsAddress: Address;
  accountIndex: bigint;
  smartAccountPdaBump: number;
}> {
  // Always use account_index = 0 for the primary smart account
  console.log('🔧 Using account index 0 for primary smart account (ignoring any provided accountIndex)');

  console.log('🔧 Deriving smart account PDA with:', {
    settingsAddress: settingsAddress.toString(),
    accountIndex: '0',
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS.toString()
  });

  const [smartAccountPda, smartAccountPdaBump] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
      new Uint8Array(Buffer.from('smart_account')),
      bs58.decode(settingsAddress),
      new Uint8Array(Buffer.from('smart_account')),
      // Use account_index 0 for the primary smart account
      new Uint8Array([0]),
    ],
  });

  console.log('✅ Derived smart account PDA:', {
    smartAccountPda: smartAccountPda.toString(),
    smartAccountPdaBump,
    settingsAddress: settingsAddress.toString(),
    accountIndex: 0
  });

  return {
    smartAccountPda,
    settingsAddress,
    accountIndex: 0n,
    smartAccountPdaBump,
  };
}
