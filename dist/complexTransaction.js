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
        feePayerAddress: params.feePayer.toString(),
        innerTransactionSize: params.innerTransactionBytes ? params.innerTransactionBytes.length : 'N/A',
        addressTableLookupsReceived: !!params.addressTableLookups,
        addressTableLookupsCount: params.addressTableLookups?.length || 0,
        memo: params.memo || 'Complex Smart Account Transaction'
    });
    console.log('🔍 Raw addressTableLookups in complexTransaction:', JSON.stringify(params.addressTableLookups, null, 2));
    console.log('🔧 About to destructure params...');
    const { rpc, smartAccountSettings, smartAccountPda, smartAccountPdaBump, signer, feePayer, innerTransactionBytes, addressTableLookups = [], inputTokenMint, } = params;
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
    console.log('🔧 Building Part 1: Propose Transaction...');
    // 5. Create the transaction account instruction
    console.log('🔧 Creating CreateTransaction instruction with transactionMessage of', transactionMessageBytes.length, 'bytes');
    console.log('🔍 transactionMessage first 16 bytes:', Array.from(transactionMessageBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
    const createTransactionInstruction = (0, instructions_1.getCreateTransactionInstruction)({
        settings: smartAccountSettings,
        transaction: transactionPda,
        creator: signer,
        rentPayer: (0, kit_1.createNoopSigner)(feePayer), // Backend pays for transaction account rent
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
        rentPayer: (0, kit_1.createNoopSigner)(feePayer), // Backend pays for proposal account rent
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
    // Create a real signer for the fee payer to ensure it's counted as a required signer
    const feePayerSigner = (0, kit_1.createNoopSigner)(feePayer);
    const proposeTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(feePayerSigner, tx), // Use fee payer as real signer for gasless transactions
    (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(proposeInstructions, tx));
    const compiledProposeTransaction = (0, kit_1.compileTransaction)(proposeTransactionMessage);
    console.log('✅ Part 1 (Propose) transaction compiled:', {
        messageSize: compiledProposeTransaction.messageBytes.length
    });
    // ===== PART 2: VOTE TRANSACTION =====
    console.log('🔧 Building Part 2: Vote Transaction...');
    // Start with the approve proposal instruction
    const voteInstructions = [approveProposalInstruction];
    // Add ATA creation instruction if inputTokenMint is provided (for Jupiter swaps with fees)
    if (inputTokenMint) {
        console.log('🏦 Creating backend fee account instruction for token:', inputTokenMint);
        // Constants for ATA creation
        const BACKEND_FEE_PAYER = 'astroi1Rrf6rqtJ1BZg7tDyx1NiUaQkYp3uD8mmTeJQ';
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        const TOKEN_PROGRAM_ID = (0, kit_1.address)('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        const ASSOCIATED_TOKEN_PROGRAM_ID = (0, kit_1.address)('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const SYSTEM_PROGRAM_ID = (0, kit_1.address)('11111111111111111111111111111111');
        // Convert native to WSOL mint
        const actualMint = inputTokenMint === 'native' ? WSOL_MINT : inputTokenMint;
        // Calculate the Associated Token Account address
        // This is a simplified PDA derivation - in a real implementation you'd use proper PDA derivation
        const backendFeePayerAddress = (0, kit_1.address)(BACKEND_FEE_PAYER);
        const mintAddress = (0, kit_1.address)(actualMint);
        // Create a simplified ATA creation instruction
        // Note: This is a basic implementation - you might want to use proper SPL token libraries
        const createATAInstruction = {
            programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
            accounts: [
                { address: feePayer, role: kit_1.AccountRole.WRITABLE_SIGNER }, // Fee payer pays for account creation
                { address: backendFeePayerAddress, role: kit_1.AccountRole.READONLY }, // Backend fee account (calculated ATA)
                { address: backendFeePayerAddress, role: kit_1.AccountRole.READONLY }, // Owner of the ATA
                { address: mintAddress, role: kit_1.AccountRole.READONLY }, // Token mint
                { address: SYSTEM_PROGRAM_ID, role: kit_1.AccountRole.READONLY }, // System program
                { address: TOKEN_PROGRAM_ID, role: kit_1.AccountRole.READONLY }, // Token program
            ],
            data: new Uint8Array(0), // ATA creation has no data
        };
        voteInstructions.push(createATAInstruction);
        console.log('✅ Added backend fee account creation to vote transaction');
    }
    const voteTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(feePayerSigner, tx), // Use fee payer as real signer for gasless transactions
    (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(voteInstructions, tx));
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
    // Create close instruction to reclaim rent back to fee payer
    const closeTransactionInstruction = (0, instructions_1.getCloseTransactionInstruction)({
        settings: smartAccountSettings,
        proposal: proposalPda,
        transaction: transactionPda,
        proposalRentCollector: feePayer, // Rent goes back to backend fee payer
        transactionRentCollector: feePayer, // Rent goes back to backend fee payer
        systemProgram: (0, kit_1.address)('11111111111111111111111111111111'),
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
        // FIRST: Prepend ALT account(s) to the beginning of accounts array
        // (smart contract expects these first in remaining_accounts)
        const altAccounts = [];
        for (const lookup of addressTableLookups) {
            console.log('📋 Adding ALT account itself:', lookup.accountKey.toString());
            altAccounts.push({
                address: lookup.accountKey,
                role: kit_1.AccountRole.READONLY, // ALT accounts are readonly
            });
        }
        // Insert ALT accounts after the explicit parameters (settings, proposal, transaction, signer)
        // The explicit parameters are at positions 0-3, so ALT accounts should start at position 4
        const explicitParamsCount = 4; // settings, proposal, transaction, signer
        const originalAccounts = executeTransactionInstruction.accounts;
        // Split the accounts: explicit params + remaining accounts
        const explicitParams = originalAccounts.slice(0, explicitParamsCount);
        const remainingAccounts = originalAccounts.slice(explicitParamsCount);
        // Create new accounts array: explicit params + ALT accounts + remaining accounts
        const newAccounts = [...explicitParams, ...altAccounts, ...remainingAccounts];
        // Create a new instruction object with correct account order
        const newInstruction = {
            ...executeTransactionInstruction,
            accounts: newAccounts
        };
        // Replace the original instruction
        Object.assign(executeTransactionInstruction, newInstruction);
        // SECOND: Add all static accounts
        for (const accountKey of decodedMessage.staticAccounts) {
            console.log('📋 Adding static account:', accountKey.toString());
            executeTransactionInstruction.accounts.push({
                address: accountKey,
                role: kit_1.AccountRole.WRITABLE, // simplified for now
            });
        }
        // THIRD: Resolve and add ALL ALT accounts in the order they appear in the message
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
                        role: kit_1.AccountRole.WRITABLE,
                    });
                }
                // Add readonly accounts from ALT (in the order they appear in the message) 
                console.log(`🔧 Processing ${(lookup.readonlyIndexes || []).length} readonly indexes from ALT`);
                for (const readonlyIndex of lookup.readonlyIndexes || []) {
                    const resolvedAddress = getAddressAtIndex(readonlyIndex);
                    console.log(`📋 Adding readonly ALT account [${readonlyIndex}] → ${resolvedAddress}`);
                    executeTransactionInstruction.accounts.push({
                        address: resolvedAddress,
                        role: kit_1.AccountRole.READONLY,
                    });
                }
                console.log(`✅ Successfully resolved ${(lookup.writableIndexes || []).length + (lookup.readonlyIndexes || []).length} accounts from ALT`);
            }
            catch (error) {
                console.error('❌ ALT resolution failed:', error);
                throw new Error(`Failed to resolve ALT ${lookup.accountKey}: ${error}`);
            }
        }
    }
    else {
        // No ALTs, add static accounts only
        console.log('🔧 No ALTs detected - adding static accounts only...');
        // Add static accounts
        for (const accountKey of decodedMessage.staticAccounts) {
            console.log('📋 Adding static account:', accountKey.toString());
            executeTransactionInstruction.accounts.push({
                address: accountKey,
                role: kit_1.AccountRole.WRITABLE, // simplified for now
            });
        }
    }
    console.log('✅ Execute instruction accounts setup completed');
    console.log('🔍 Final execute instruction accounts count:', executeTransactionInstruction.accounts.length);
    console.log('🔍 Account order verification:');
    executeTransactionInstruction.accounts.forEach((account, index) => {
        console.log(`  [${index}] ${account.address} (role: ${account.role})`);
    });
    // Check for duplicate signer accounts
    const signerAddresses = executeTransactionInstruction.accounts
        .filter(account => account.role === 2)
        .map(account => account.address);
    console.log('🔍 Signer accounts found:', signerAddresses);
    const uniqueSigners = new Set(signerAddresses);
    if (signerAddresses.length !== uniqueSigners.size) {
        console.error('❌ DUPLICATE SIGNER ACCOUNTS DETECTED!');
        console.error('Signer addresses:', signerAddresses);
        console.error('Unique signers:', Array.from(uniqueSigners));
    }
    const executeInstructions = [executeTransactionInstruction, closeTransactionInstruction];
    const executeTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(feePayerSigner, tx), // Use fee payer as real signer for gasless transactions
    (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(executeInstructions, tx));
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
