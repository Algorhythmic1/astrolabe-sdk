"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveTransactionPda = deriveTransactionPda;
exports.deriveProposalPda = deriveProposalPda;
exports.fetchSmartAccountSettings = fetchSmartAccountSettings;
exports.decodeTransactionMessage = decodeTransactionMessage;
exports.deriveSmartAccountInfo = deriveSmartAccountInfo;
const kit_1 = require("@solana/kit");
const buffer_1 = require("buffer");
const bs58_1 = __importDefault(require("bs58"));
const settings_1 = require("../clients/js/src/generated/accounts/settings");
const programs_1 = require("../clients/js/src/generated/programs");
/**
 * Derives a transaction PDA from settings address and transaction index
 */
async function deriveTransactionPda(settingsAddress, transactionIndex) {
    const [transactionPda] = await (0, kit_1.getProgramDerivedAddress)({
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        seeds: [
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            bs58_1.default.decode(settingsAddress),
            new Uint8Array(buffer_1.Buffer.from('transaction')),
            new Uint8Array(new BigUint64Array([transactionIndex]).buffer),
        ],
    });
    return transactionPda;
}
/**
 * Derives a proposal PDA from settings address and transaction index
 */
async function deriveProposalPda(settingsAddress, transactionIndex) {
    const [proposalPda] = await (0, kit_1.getProgramDerivedAddress)({
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        seeds: [
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            bs58_1.default.decode(settingsAddress),
            new Uint8Array(buffer_1.Buffer.from('transaction')),
            new Uint8Array(new BigUint64Array([transactionIndex]).buffer),
            new Uint8Array(buffer_1.Buffer.from('proposal')),
        ],
    });
    return proposalPda;
}
/**
 * Fetches smart account settings and returns current and next transaction indices
 */
async function fetchSmartAccountSettings(rpc, settingsAddress) {
    const settings = await (0, settings_1.fetchSettings)(rpc, settingsAddress);
    return {
        currentTransactionIndex: settings.data.transactionIndex,
        nextTransactionIndex: settings.data.transactionIndex + 1n,
        threshold: settings.data.threshold
    };
}
/**
 * Decodes a compiled transaction message to extract accounts and instructions
 */
function decodeTransactionMessage(messageBytes) {
    return (0, kit_1.getCompiledTransactionMessageDecoder)().decode(messageBytes);
}
/**
 * Derives smart account PDA and related info from a settings address
 */
async function deriveSmartAccountInfo(rpc, settingsAddress, accountIndex) {
    // Always use account_index = 0 for the primary smart account
    console.log('🔧 Using account index 0 for primary smart account (ignoring any provided accountIndex)');
    console.log('🔧 Deriving smart account PDA with:', {
        settingsAddress: settingsAddress.toString(),
        accountIndex: '0',
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS.toString()
    });
    const [smartAccountPda, smartAccountPdaBump] = await (0, kit_1.getProgramDerivedAddress)({
        programAddress: programs_1.ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
        seeds: [
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
            bs58_1.default.decode(settingsAddress),
            new Uint8Array(buffer_1.Buffer.from('smart_account')),
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
