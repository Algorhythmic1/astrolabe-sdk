import { Address, createSolanaRpc, type TransactionSigner } from '@solana/kit';
type SolanaRpc = ReturnType<typeof createSolanaRpc>;
export interface ComplexTransactionParams {
    /** RPC client for blockchain interaction */
    rpc: SolanaRpc;
    /** Smart account settings PDA address */
    smartAccountSettings: Address;
    /** Smart account PDA address that will execute the transaction */
    smartAccountPda: Address;
    /** Smart account PDA bump seed */
    smartAccountPdaBump: number;
    /** Transaction signer (the user) */
    signer: TransactionSigner;
    /** Fee payer address (backend will replace with actual signer) */
    feePayer: Address;
    /** Raw transaction bytes (alternative to innerInstructions) - preserves ALT structure */
    innerTransactionBytes?: Uint8Array;
    /** Address table lookups for ALT support */
    addressTableLookups?: any[];
    /** Optional memo for the transaction */
    memo?: string;
    /** Optional: Input token mint for creating backend fee account (for Jupiter swaps) */
    inputTokenMint?: string;
}
export interface ComplexTransactionResult {
    /** First transaction: propose only (contains Jupiter data) */
    proposeTransactionBuffer: Uint8Array;
    /** Second transaction: vote only */
    voteTransactionBuffer: Uint8Array;
    /** Third transaction: execute only */
    executeTransactionBuffer: Uint8Array;
    /** Transaction PDA address */
    transactionPda: Address;
    /** Proposal PDA address */
    proposalPda: Address;
    /** Transaction index used */
    transactionIndex: bigint;
}
/**
 * Creates a complex transaction split into three parts for large transactions like swaps
 * Part 1: propose (contains Jupiter data - medium size)
 * Part 2: vote (minimal size)
 * Part 3: execute (medium size with account references)
 */
export declare function createComplexTransaction(params: ComplexTransactionParams): Promise<ComplexTransactionResult>;
export {};
