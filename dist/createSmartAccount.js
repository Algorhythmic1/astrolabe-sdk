"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSmartAccountTransaction = createSmartAccountTransaction;
const kit_1 = require("@solana/kit");
const buffer_1 = require("buffer");
const programConfig_1 = require("./clients/js/src/generated/accounts/programConfig");
const instructions_1 = require("./clients/js/src/generated/instructions");
const programs_1 = require("./clients/js/src/generated/programs");
const bs58_1 = __importDefault(require("bs58"));
/**
 * Creates an unsigned, compiled transaction buffer to deploy a new smart account.
 * This function fetches the necessary on-chain data, derives the required PDAs,
 * and constructs the transaction. The resulting buffer is intended to be sent to a backend
 * where it will be signed by the `creator` account and submitted to the network.
 *
 * @param params - The parameters for creating the smart account.
 * @returns A promise that resolves to the transaction buffer and the new settings account address.
 */
async function createSmartAccountTransaction(params) {
    const { rpc, creator, feePayer, threshold, signers = [], restrictedSigners = [], settingsAuthority = null, timeLock = 0, rentCollector = null, memo = null, } = params;
    // 1. Fetch program config PDA and treasury from on-chain, as seen in createAccountTest.ts
    const [programConfigPda] = await (0, kit_1.getProgramDerivedAddress)({
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        seeds: [
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            new Uint8Array(buffer_1.Buffer.from('program_config')),
        ],
    });
    const programConfig = await (0, programConfig_1.fetchProgramConfig)(rpc, programConfigPda);
    const { treasury, smartAccountIndex } = programConfig.data;
    // 2. Compute the seed for the new settings account using the next available index.
    const nextSmartAccountIndex = smartAccountIndex + 1n;
    const settingsSeed = new Uint8Array(16); // u128 is 16 bytes
    const view = new DataView(settingsSeed.buffer);
    view.setBigUint64(0, nextSmartAccountIndex, true); // low 64 bits
    view.setBigUint64(8, 0n, true); // high 64 bits
    // 3. Derive the settings PDA
    const [settingsAddress] = await (0, kit_1.getProgramDerivedAddress)({
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        seeds: [
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            new Uint8Array(buffer_1.Buffer.from('settings')),
            settingsSeed,
        ],
    });
    // 4. Derive the smart account PDA. This must match the derivation used by the program.
    // The wallet PDA is derived from its associated settings account using account_index = 0
    const [smartAccountPda] = await (0, kit_1.getProgramDerivedAddress)({
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        seeds: [
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            bs58_1.default.decode(settingsAddress),
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            // Use account_index = 0 for the primary smart account (matches program expectations)
            new Uint8Array([0]),
        ],
    });
    // 5. Build the create smart account instruction.
    // The creator is represented as a NoopSigner because the transaction
    // will be signed later by a backend.
    const createSmartAccountInstruction = await (0, instructions_1.getCreateSmartAccountInstructionAsync)({
        programConfig: programConfigPda,
        settings: settingsAddress,
        treasury,
        creator: (0, kit_1.createNoopSigner)(creator),
        systemProgram: (0, kit_1.address)('11111111111111111111111111111111'),
        program: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        settingsAuthority,
        threshold,
        signers,
        restrictedSigners,
        timeLock,
        rentCollector,
        memo,
    });
    // 6. Build the base transaction message. The fee payer is the creator,
    // also represented as a NoopSigner.
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const baseTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)((0, kit_1.createNoopSigner)(feePayer), tx), (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)([createSmartAccountInstruction], tx));
    // 7. Compile the transaction to get the buffer to be sent to the backend
    const compiledTransaction = (0, kit_1.compileTransaction)(baseTransactionMessage);
    return {
        transactionBuffer: new Uint8Array(compiledTransaction.messageBytes),
        smartAccountPda: (0, kit_1.address)(smartAccountPda),
        settingsAddress: (0, kit_1.address)(settingsAddress),
        nextSmartAccountIndex: nextSmartAccountIndex,
    };
}
