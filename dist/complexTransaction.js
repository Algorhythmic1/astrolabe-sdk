"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createComplexTransaction = createComplexTransaction;
const kit_1 = require("@solana/kit");
const bs58_1 = __importDefault(require("bs58"));
const instructions_1 = require("./clients/js/src/generated/instructions");
const smartAccountTransactionMessage_1 = require("./clients/js/src/generated/types/smartAccountTransactionMessage");
const index_1 = require("./utils/index");
/**
 * Creates a complex transaction split into three parts for large transactions like swaps
 * Part 1: propose (contains Jupiter data - medium size)
 * Part 2: vote (minimal size)
 * Part 3: execute (medium size with account references)
 */
async function createComplexTransaction(params) {
    console.log('🚀 Starting createComplexTransaction...');
    console.log('🔍 Params type:', typeof params);
    console.log('🔍 Params is null/undefined:', params == null);
    if (params.innerTransactionBytes) {
        console.log('🔍 innerTransactionBytes exists:', true);
        console.log('🔍 innerTransactionBytes type:', typeof params.innerTransactionBytes);
        console.log('🔍 innerTransactionBytes length:', params.innerTransactionBytes.length);
    }
    else {
        console.log('🔍 innerTransactionBytes exists:', false);
    }
    console.log('📋 Input params:', {
        smartAccountSettings: params.smartAccountSettings.toString(),
        smartAccountPda: params.smartAccountPda.toString(),
        smartAccountPdaBump: params.smartAccountPdaBump,
        signerAddress: params.signer.address.toString(),
        innerTransactionSize: params.innerTransactionBytes ? params.innerTransactionBytes.length : 'N/A',
        addressTableLookupsReceived: !!params.addressTableLookups,
        addressTableLookupsCount: params.addressTableLookups?.length || 0,
        memo: params.memo || 'Complex Smart Account Transaction'
    });
    console.log('🔍 Raw addressTableLookups in complexTransaction:', JSON.stringify(params.addressTableLookups, null, 2));
    console.log('🔧 About to destructure params...');
    const { rpc, smartAccountSettings, smartAccountPda, smartAccountPdaBump, signer, innerTransactionBytes, addressTableLookups = [], } = params;
    const memo = params.memo || 'Complex Smart Account Transaction';
    console.log('✅ Destructuring completed');
    console.log('🔍 After destructuring - addressTableLookups:', JSON.stringify(addressTableLookups, null, 2));
    console.log('🔍 After destructuring - addressTableLookups.length:', addressTableLookups?.length);
    // Validate that we have transaction bytes
    if (!innerTransactionBytes) {
        throw new Error('innerTransactionBytes is required for complex transactions');
    }
    console.log('🔧 Step 1: Fetching latest settings state...');
    // 1. Fetch the current smart account settings to get the next transaction index
    const settingsAccount = await (0, index_1.fetchSmartAccountSettings)(rpc, smartAccountSettings);
    const transactionIndex = settingsAccount.nextTransactionIndex;
    console.log('✅ Settings fetched:', {
        currentTransactionIndex: settingsAccount.currentTransactionIndex.toString(),
        nextTransactionIndex: transactionIndex.toString(),
        threshold: settingsAccount.threshold,
    });
    console.log('🔧 Step 2: Deriving transaction PDA...');
    // 2. Derive the transaction PDA
    const transactionPda = await (0, index_1.deriveTransactionPda)(smartAccountSettings, transactionIndex);
    console.log('✅ Transaction PDA derived:', transactionPda.toString());
    console.log('🔧 Step 3: Deriving proposal PDA...');
    // 3. Derive the proposal PDA
    const proposalPda = await (0, index_1.deriveProposalPda)(smartAccountSettings, transactionIndex);
    console.log('✅ Proposal PDA derived:', proposalPda.toString());
    console.log('🔧 Step 4: Building inner transaction message...');
    console.log('🔧 Using raw transaction bytes (preserving ALT structure)...');
    console.log('🔍 Raw transaction bytes type:', typeof innerTransactionBytes);
    console.log('🔍 Raw transaction bytes length:', innerTransactionBytes.length);
    console.log('✅ Raw transaction bytes used:', { messageSize: innerTransactionBytes.length });
    // 4. Decode the inner transaction message to extract account info
    console.log('🔧 Decoding compiled message...');
    const compiledInnerMessage = { messageBytes: innerTransactionBytes };
    console.log('🔍 compiledInnerMessage:', { messageBytes: `Uint8Array(${compiledInnerMessage.messageBytes.length})` });
    console.log('🔍 messageBytes type:', typeof compiledInnerMessage.messageBytes);
    console.log('🔍 messageBytes length:', compiledInnerMessage.messageBytes.length);
    console.log('🔍 messageBytes first 16 bytes:', Array.from(compiledInnerMessage.messageBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    console.log('✅ Message decoded successfully');
    const decodedMessage = (0, index_1.decodeTransactionMessage)(compiledInnerMessage.messageBytes);
    console.log('✅ Inner transaction compiled:', {
        staticAccounts: decodedMessage.staticAccounts.length,
        instructions: decodedMessage.instructions.length,
        messageSize: compiledInnerMessage.messageBytes.length,
    });
    console.log('🔧 Converting Jupiter transaction to smart account format...');
    // Convert from Jupiter's standard Solana format to smart account's custom format
    const numSigners = decodedMessage.header.numSignerAccounts;
    const numReadonlySigners = decodedMessage.header.numReadonlySignerAccounts;
    const numWritableSigners = numSigners - numReadonlySigners;
    const numWritableNonSigners = decodedMessage.staticAccounts.length - numSigners - decodedMessage.header.numReadonlyNonSignerAccounts;
    const smartAccountMessage = {
        numSigners: numSigners,
        numWritableSigners: numWritableSigners,
        numWritableNonSigners: numWritableNonSigners,
        accountKeys: decodedMessage.staticAccounts,
        instructions: decodedMessage.instructions.map(ix => ({
            programIdIndex: ix.programAddressIndex,
            accountIndexes: new Uint8Array(ix.accountIndices ?? []),
            data: ix.data ?? new Uint8Array(),
        })),
        // Use the passed address table lookups (from Jupiter transaction)
        addressTableLookups: addressTableLookups.map(lookup => ({
            accountKey: lookup.accountKey,
            writableIndexes: new Uint8Array(lookup.writableIndexes ?? []),
            readonlyIndexes: new Uint8Array(lookup.readonlyIndexes ?? []),
        })),
    };
    console.log('🔧 Encoding smart account transaction message...');
    const transactionMessageBytes = (0, smartAccountTransactionMessage_1.getSmartAccountTransactionMessageEncoder)().encode(smartAccountMessage);
    console.log('✅ Smart account transaction message encoded:', {
        messageSize: transactionMessageBytes.length,
        numSigners: smartAccountMessage.numSigners,
        numAccounts: smartAccountMessage.accountKeys.length,
        numInstructions: smartAccountMessage.instructions.length,
        innerJupiterSize: transactionMessageBytes.length,
        estimatedProposeSize: transactionMessageBytes.length + 200 // rough estimate
    });
    // ===== PART 1: PROPOSE + VOTE TRANSACTION =====
    console.log('🔧 Building Part 1: Propose + Vote Transaction...');
    // 5. Create the transaction account instruction
    console.log('🔧 Creating CreateTransaction instruction with transactionMessage of', transactionMessageBytes.length, 'bytes');
    console.log('🔍 transactionMessage first 16 bytes:', Array.from(transactionMessageBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    const createTransactionInstruction = (0, instructions_1.getCreateTransactionInstruction)({
        settings: smartAccountSettings,
        transaction: transactionPda,
        creator: signer,
        rentPayer: signer,
        systemProgram: (0, kit_1.address)('11111111111111111111111111111111'),
        args: {
            accountIndex: 0, // Use 0 for the primary smart account
            accountBump: smartAccountPdaBump,
            ephemeralSigners: 0,
            transactionMessage: transactionMessageBytes,
            memo,
        },
    });
    // 6. Create the proposal instruction
    const createProposalInstruction = (0, instructions_1.getCreateProposalInstruction)({
        settings: smartAccountSettings,
        proposal: proposalPda,
        creator: signer,
        rentPayer: signer,
        systemProgram: (0, kit_1.address)('11111111111111111111111111111111'),
        transactionIndex: transactionIndex,
        draft: false,
    });
    // 7. Create the approve proposal instruction
    const approveProposalInstruction = (0, instructions_1.getApproveProposalInstruction)({
        settings: smartAccountSettings,
        signer: signer,
        proposal: proposalPda,
        systemProgram: (0, kit_1.address)('11111111111111111111111111111111'),
        args: { memo: null },
    });
    // Build Part 1 transaction (propose only - contains the large Jupiter data)
    const proposeInstructions = [
        createTransactionInstruction,
        createProposalInstruction,
    ];
    const latestBlockhashResponse = await rpc.getLatestBlockhash().send();
    const latestBlockhash = latestBlockhashResponse.value;
    const proposeTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(signer, tx), (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(proposeInstructions, tx));
    const compiledProposeTransaction = (0, kit_1.compileTransaction)(proposeTransactionMessage);
    console.log('✅ Part 1 (Propose) transaction compiled:', {
        messageSize: compiledProposeTransaction.messageBytes.length
    });
    // ===== PART 2: VOTE TRANSACTION =====
    console.log('🔧 Building Part 2: Vote Transaction...');
    const voteInstructions = [approveProposalInstruction];
    const voteTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(signer, tx), (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(voteInstructions, tx));
    const compiledVoteTransaction = (0, kit_1.compileTransaction)(voteTransactionMessage);
    console.log('✅ Part 2 (Vote) transaction compiled:', {
        messageSize: compiledVoteTransaction.messageBytes.length
    });
    // ===== PART 3: EXECUTE TRANSACTION =====
    console.log('🔧 Building Part 3: Execute Transaction...');
    // Create the execute transaction instruction
    const executeTransactionInstruction = (0, instructions_1.getExecuteTransactionInstruction)({
        settings: smartAccountSettings,
        proposal: proposalPda,
        transaction: transactionPda,
        signer: signer,
    });
    // The smart contract expects manual ALT resolution - we need to provide:
    // 1. Static accounts + resolved ALT accounts in message_account_infos
    // 2. ALT accounts themselves in address_lookup_table_account_infos
    console.log('🔧🔧🔧 EXECUTE TRANSACTION ACCOUNT SETUP STARTING 🔧🔧🔧');
    console.log('🔧 Smart contract expects manual ALT resolution');
    console.log('🔍 addressTableLookups exists:', !!addressTableLookups);
    console.log('🔍 addressTableLookups type:', typeof addressTableLookups);
    console.log('🔍 addressTableLookups length:', addressTableLookups?.length || 0);
    console.log('🔍 addressTableLookups:', JSON.stringify(addressTableLookups || [], null, 2));
    console.log('🔍 Static accounts:', decodedMessage.staticAccounts?.length || 0);
    if (addressTableLookups && addressTableLookups.length > 0) {
        console.log('🔧 Processing ALT transaction - manual resolution required');
        // First, add all static accounts
        for (const accountKey of decodedMessage.staticAccounts) {
            console.log('📋 Adding static account:', accountKey.toString());
            executeTransactionInstruction.accounts.push({
                address: accountKey,
                role: 1, // AccountRole.WRITABLE - simplified for now
            });
        }
        // Then, resolve and add ALL ALT accounts in the order they appear in the message
        for (const lookup of addressTableLookups) {
            console.log('🔧 Resolving ALT:', lookup.accountKey.toString());
            try {
                // Fetch ALT account and parse its addresses using proper encoding
                const altAccountInfo = await rpc.getAccountInfo(lookup.accountKey, {
                    encoding: 'base64',
                    commitment: 'finalized'
                }).send();
                if (!altAccountInfo.value?.data) {
                    throw new Error(`ALT account ${lookup.accountKey} not found`);
                }
                // Parse ALT data - it's stored as base64
                const altDataBase64 = Array.isArray(altAccountInfo.value.data)
                    ? altAccountInfo.value.data[0]
                    : altAccountInfo.value.data;
                const altData = Buffer.from(altDataBase64, 'base64');
                // ALT data structure: 
                // - 56 bytes header (discriminator + metadata)
                // - Remaining data: 32-byte public keys 
                const HEADER_SIZE = 56;
                const PUBKEY_SIZE = 32;
                if (altData.length < HEADER_SIZE) {
                    throw new Error(`Invalid ALT data size: ${altData.length}`);
                }
                const totalAddresses = Math.floor((altData.length - HEADER_SIZE) / PUBKEY_SIZE);
                console.log(`🔍 ALT contains ${totalAddresses} addresses`);
                // Helper function to extract address at specific index
                const getAddressAtIndex = (index) => {
                    if (index >= totalAddresses) {
                        throw new Error(`Index ${index} out of bounds for ALT with ${totalAddresses} addresses`);
                    }
                    const offset = HEADER_SIZE + (index * PUBKEY_SIZE);
                    const pubkeyBytes = altData.subarray(offset, offset + PUBKEY_SIZE);
                    // Convert to base58 string (Solana address format)
                    const addressString = bs58_1.default.encode(pubkeyBytes);
                    return (0, kit_1.address)(addressString);
                };
                // Add writable accounts from ALT (in the order they appear in the message)
                console.log(`🔧 Processing ${(lookup.writableIndexes || []).length} writable indexes from ALT`);
                for (const writableIndex of lookup.writableIndexes || []) {
                    const resolvedAddress = getAddressAtIndex(writableIndex);
                    console.log(`📋 Adding writable ALT account [${writableIndex}] → ${resolvedAddress}`);
                    executeTransactionInstruction.accounts.push({
                        address: resolvedAddress,
                        role: 1, // AccountRole.WRITABLE
                    });
                }
                // Add readonly accounts from ALT (in the order they appear in the message) 
                console.log(`🔧 Processing ${(lookup.readonlyIndexes || []).length} readonly indexes from ALT`);
                for (const readonlyIndex of lookup.readonlyIndexes || []) {
                    const resolvedAddress = getAddressAtIndex(readonlyIndex);
                    console.log(`📋 Adding readonly ALT account [${readonlyIndex}] → ${resolvedAddress}`);
                    executeTransactionInstruction.accounts.push({
                        address: resolvedAddress,
                        role: 0, // AccountRole.READONLY
                    });
                }
                console.log(`✅ Successfully resolved ${(lookup.writableIndexes || []).length + (lookup.readonlyIndexes || []).length} accounts from ALT`);
            }
            catch (error) {
                console.error('❌ ALT resolution failed:', error);
                throw new Error(`Failed to resolve ALT ${lookup.accountKey}: ${error}`);
            }
            // Add the ALT account itself at the end (this is what the smart contract validates)
            console.log('📋 Adding ALT account itself:', lookup.accountKey.toString());
            executeTransactionInstruction.accounts.push({
                address: lookup.accountKey,
                role: 0, // AccountRole.READONLY - ALT accounts are readonly
            });
        }
    }
    else {
        // No ALTs, add static accounts normally
        console.log('🔧 No ALTs detected - adding static accounts to execute instruction...');
        for (const accountKey of decodedMessage.staticAccounts) {
            console.log('📋 Adding static account:', accountKey.toString());
            executeTransactionInstruction.accounts.push({
                address: accountKey,
                role: 1, // AccountRole.WRITABLE - simplified for now
            });
        }
    }
    console.log('✅ Execute instruction accounts setup completed');
    console.log('🔍 Final execute instruction accounts count:', executeTransactionInstruction.accounts.length);
    const executeInstructions = [executeTransactionInstruction];
    const executeTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(signer, tx), (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(executeInstructions, tx));
    const compiledExecuteTransaction = (0, kit_1.compileTransaction)(executeTransactionMessage);
    console.log('✅ Part 3 (Execute) transaction compiled:', {
        messageSize: compiledExecuteTransaction.messageBytes.length
    });
    console.log('🎉 Complex transaction split completed:', {
        part1Size: compiledProposeTransaction.messageBytes.length,
        part2Size: compiledVoteTransaction.messageBytes.length,
        part3Size: compiledExecuteTransaction.messageBytes.length,
        totalSize: compiledProposeTransaction.messageBytes.length + compiledVoteTransaction.messageBytes.length + compiledExecuteTransaction.messageBytes.length,
        transactionIndex: transactionIndex.toString()
    });
    return {
        proposeTransactionBuffer: new Uint8Array(compiledProposeTransaction.messageBytes),
        voteTransactionBuffer: new Uint8Array(compiledVoteTransaction.messageBytes),
        executeTransactionBuffer: new Uint8Array(compiledExecuteTransaction.messageBytes),
        transactionPda,
        proposalPda,
        transactionIndex,
    };
}
