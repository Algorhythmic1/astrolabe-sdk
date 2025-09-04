"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createComplexTransaction = createComplexTransaction;
const kit_1 = require("@solana/kit");
const instructions_1 = require("./clients/js/src/generated/instructions");
const smartAccountTransactionMessage_1 = require("./clients/js/src/generated/types/smartAccountTransactionMessage");
const index_1 = require("./utils/index");
/**
 * Creates a complex transaction split into two parts for large transactions like swaps
 * Part 1: propose + vote (smaller transaction)
 * Part 2: execute (larger transaction with embedded inner transaction)
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
        memo: params.memo || 'Complex Smart Account Transaction'
    });
    console.log('🔧 About to destructure params...');
    const { rpc, smartAccountSettings, smartAccountPda, smartAccountPdaBump, signer, innerTransactionBytes, } = params;
    const memo = params.memo || 'Complex Smart Account Transaction';
    console.log('✅ Destructuring completed');
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
    console.log('✅ Message decoded successfully');
    const decodedMessage = (0, index_1.decodeTransactionMessage)(compiledInnerMessage.messageBytes);
    console.log('✅ Inner transaction compiled:', {
        staticAccounts: decodedMessage.staticAccounts.length,
        instructions: decodedMessage.instructions.length,
        messageSize: compiledInnerMessage.messageBytes.length,
    });
    console.log('🔧 Creating smart account transaction message...');
    // Manually construct the smart account transaction message
    const smartAccountMessage = {
        numSigners: 1,
        numWritableSigners: 1,
        numWritableNonSigners: decodedMessage.staticAccounts.length - 1,
        accountKeys: decodedMessage.staticAccounts,
        instructions: decodedMessage.instructions.map(ix => ({
            programIdIndex: ix.programAddressIndex,
            accountIndexes: new Uint8Array(ix.accountIndices ?? []),
            data: ix.data ?? new Uint8Array(),
        })),
        addressTableLookups: [],
    };
    const transactionMessageBytes = (0, smartAccountTransactionMessage_1.getSmartAccountTransactionMessageEncoder)().encode(smartAccountMessage);
    console.log('✅ Smart account transaction message encoded:', {
        messageSize: transactionMessageBytes.length,
        numSigners: smartAccountMessage.numSigners,
        numAccounts: smartAccountMessage.accountKeys.length,
        numInstructions: smartAccountMessage.instructions.length
    });
    // ===== PART 1: PROPOSE + VOTE TRANSACTION =====
    console.log('🔧 Building Part 1: Propose + Vote Transaction...');
    // 5. Create the transaction account instruction
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
    // Build Part 1 transaction (propose + vote)
    const proposeVoteInstructions = [
        createTransactionInstruction,
        createProposalInstruction,
        approveProposalInstruction,
    ];
    const latestBlockhashResponse = await rpc.getLatestBlockhash().send();
    const latestBlockhash = latestBlockhashResponse.value;
    const proposeVoteTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(signer, tx), (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(proposeVoteInstructions, tx));
    const compiledProposeVoteTransaction = (0, kit_1.compileTransaction)(proposeVoteTransactionMessage);
    console.log('✅ Part 1 (Propose + Vote) transaction compiled:', {
        messageSize: compiledProposeVoteTransaction.messageBytes.length
    });
    // ===== PART 2: EXECUTE TRANSACTION =====
    console.log('🔧 Building Part 2: Execute Transaction...');
    // 8. Create the execute transaction instruction
    const executeTransactionInstruction = (0, instructions_1.getExecuteTransactionInstruction)({
        settings: smartAccountSettings,
        proposal: proposalPda,
        transaction: transactionPda,
        signer: signer,
    });
    // Add the required accounts for the inner instructions to the execute instruction
    for (const accountKey of decodedMessage.staticAccounts) {
        executeTransactionInstruction.accounts.push({
            address: accountKey,
            role: 1, // AccountRole.WRITABLE - simplified for now
        });
    }
    // Build Part 2 transaction (execute only)
    const executeInstructions = [executeTransactionInstruction];
    const executeTransactionMessage = (0, kit_1.pipe)((0, kit_1.createTransactionMessage)({ version: 0 }), (tx) => (0, kit_1.setTransactionMessageFeePayerSigner)(signer, tx), (tx) => (0, kit_1.setTransactionMessageLifetimeUsingBlockhash)(latestBlockhash, tx), (tx) => (0, kit_1.appendTransactionMessageInstructions)(executeInstructions, tx));
    const compiledExecuteTransaction = (0, kit_1.compileTransaction)(executeTransactionMessage);
    console.log('✅ Part 2 (Execute) transaction compiled:', {
        messageSize: compiledExecuteTransaction.messageBytes.length
    });
    console.log('🎉 Complex transaction split completed:', {
        part1Size: compiledProposeVoteTransaction.messageBytes.length,
        part2Size: compiledExecuteTransaction.messageBytes.length,
        totalSize: compiledProposeVoteTransaction.messageBytes.length + compiledExecuteTransaction.messageBytes.length,
        transactionIndex: transactionIndex.toString()
    });
    return {
        proposeVoteTransactionBuffer: new Uint8Array(compiledProposeVoteTransaction.messageBytes),
        executeTransactionBuffer: new Uint8Array(compiledExecuteTransaction.messageBytes),
        transactionPda,
        proposalPda,
        transactionIndex,
    };
}
