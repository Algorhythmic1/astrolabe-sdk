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
    /** Raw transaction bytes (alternative to innerInstructions) - preserves ALT structure */
    innerTransactionBytes?: Uint8Array;
    /** Optional memo for the transaction */
    memo?: string;
}
export interface ComplexTransactionResult {
    /** First transaction: propose + vote */
    proposeVoteTransactionBuffer: Uint8Array;
    /** Second transaction: execute */
    executeTransactionBuffer: Uint8Array;
    /** Transaction PDA address */
    transactionPda: Address;
    /** Proposal PDA address */
    proposalPda: Address;
    /** Transaction index used */
    transactionIndex: bigint;
}
/**
 * Creates a complex transaction split into two parts for large transactions like swaps
 * Part 1: propose + vote (smaller transaction)
 * Part 2: execute (larger transaction with embedded inner transaction)
 */
export declare function createComplexTransaction(params: ComplexTransactionParams): Promise<ComplexTransactionResult>;
export {};
