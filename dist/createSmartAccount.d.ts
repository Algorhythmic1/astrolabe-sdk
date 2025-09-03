import { type Address, createSolanaRpc } from '@solana/kit';
import { type RestrictedSmartAccountSignerArgs, type SmartAccountSignerArgs } from './clients/js/src/generated/types';
type SolanaRpc = ReturnType<typeof createSolanaRpc>;
/**
 * Parameters for creating a new smart account, intended to be called from a frontend.
 */
export type CreateSmartAccountParams = {
    /** The RPC client to use for fetching on-chain data. */
    rpc: SolanaRpc;
    /**
     * The public key of the account that will create the smart account and pay for transaction fees.
     * This account must sign the final transaction on the backend.
     */
    creator: Address;
    /**
   * The public key of the account that will pay for transaction fees.
   * This can be different from the creator.
   */
    feePayer: Address;
    /** The signature threshold required to execute a transaction. */
    threshold: number;
    /** The initial set of signers on the smart account. */
    signers?: SmartAccountSignerArgs[];
    /** Optional: The initial set of restricted signers on the smart account. */
    restrictedSigners?: RestrictedSmartAccountSignerArgs[];
    /** Optional: The authority that can configure the smart account. Defaults to None. */
    settingsAuthority?: Address | null;
    /** Optional: The number of seconds for the time lock. Defaults to 0. */
    timeLock?: number;
    /** Optional: The address to collect rent from closed accounts. Defaults to None. */
    rentCollector?: Address | null;
    /** Optional: A memo for the transaction. Defaults to None. */
    memo?: string | null;
};
/**
 * The result of preparing a smart account creation transaction.
 */
export type CreateSmartAccountResult = {
    /** The unsigned, compiled transaction message as a byte array, ready to be sent to a backend. */
    transactionBuffer: Uint8Array;
    /** The derived address of the new smart account. */
    smartAccountPda: Address;
    /** The derived address of the new smart account's settings account. */
    settingsAddress: Address;
    /** The next available index for a new smart account. */
    nextSmartAccountIndex: bigint;
};
/**
 * Creates an unsigned, compiled transaction buffer to deploy a new smart account.
 * This function fetches the necessary on-chain data, derives the required PDAs,
 * and constructs the transaction. The resulting buffer is intended to be sent to a backend
 * where it will be signed by the `creator` account and submitted to the network.
 *
 * @param params - The parameters for creating the smart account.
 * @returns A promise that resolves to the transaction buffer and the new settings account address.
 */
export declare function createSmartAccountTransaction(params: CreateSmartAccountParams): Promise<CreateSmartAccountResult>;
export {};
