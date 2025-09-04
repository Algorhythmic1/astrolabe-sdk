import { Address, createSolanaRpc } from '@solana/kit';
type SolanaRpc = ReturnType<typeof createSolanaRpc>;
/**
 * Derives a transaction PDA from settings address and transaction index
 */
export declare function deriveTransactionPda(settingsAddress: Address, transactionIndex: bigint): Promise<Address>;
/**
 * Derives a proposal PDA from settings address and transaction index
 */
export declare function deriveProposalPda(settingsAddress: Address, transactionIndex: bigint): Promise<Address>;
/**
 * Fetches smart account settings and returns current and next transaction indices
 */
export declare function fetchSmartAccountSettings(rpc: SolanaRpc, settingsAddress: Address): Promise<{
    currentTransactionIndex: bigint;
    nextTransactionIndex: bigint;
    threshold: number;
}>;
/**
 * Decodes a compiled transaction message to extract accounts and instructions
 */
export declare function decodeTransactionMessage(messageBytes: Uint8Array): import("@solana/kit").CompiledTransactionMessage;
/**
 * Derives smart account PDA and related info from a settings address
 */
export declare function deriveSmartAccountInfo(rpc: SolanaRpc, settingsAddress: Address, accountIndex?: bigint): Promise<{
    smartAccountPda: Address;
    settingsAddress: Address;
    accountIndex: bigint;
    smartAccountPdaBump: number;
}>;
export {};
