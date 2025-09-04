import { type Address, createSolanaRpc, type TransactionSigner } from '@solana/kit';
type SolanaRpc = ReturnType<typeof createSolanaRpc>;
/**
 * Result of deriving smart account info from settings address
 */
export type SmartAccountInfo = {
    /** The smart account PDA that holds funds */
    smartAccountPda: Address;
    /** The settings address (input) */
    settingsAddress: Address;
    /** The account index used for derivation */
    accountIndex: bigint;
    /** The smart account PDA bump seed */
    smartAccountPdaBump: number;
};
export { deriveSmartAccountInfo } from './utils';
/**
 * Parameters for the propose-vote-execute workflow
 */
export type ProposeVoteExecuteParams = {
    /** The RPC client to use for fetching on-chain data. */
    rpc: SolanaRpc;
    /** The smart account settings address (PDA) */
    smartAccountSettings: Address;
    /** The smart account PDA that will sign the inner transaction */
    smartAccountPda: Address;
    /** The smart account PDA bump */
    smartAccountPdaBump: number;
    /** The signer who will create proposal, vote, and execute */
    signer: TransactionSigner;
    /** The inner instructions to execute within the smart account */
    innerInstructions?: any[];
    /** Raw transaction bytes (alternative to innerInstructions) - preserves ALT structure */
    innerTransactionBytes?: Uint8Array;
    /** Optional memo for the transaction */
    memo?: string;
};
/**
 * Result of the propose-vote-execute workflow
 */
export type ProposeVoteExecuteResult = {
    /** The serialized transaction buffer ready to be sent to backend */
    transactionBuffer: Uint8Array;
    /** The transaction PDA that was created */
    transactionPda: Address;
    /** The proposal PDA that was created */
    proposalPda: Address;
    /** The transaction index used */
    transactionIndex: bigint;
};
/**
 * High-level function that combines the smart account propose-vote-execute pattern
 * into a single serialized transaction. This creates a transaction, proposal, approves it,
 * and executes it all in one atomic operation.
 *
 * @param params - The parameters for the workflow
 * @returns Promise resolving to transaction buffer and metadata
 */
export declare function createProposeVoteExecuteTransaction(params: ProposeVoteExecuteParams): Promise<ProposeVoteExecuteResult>;
