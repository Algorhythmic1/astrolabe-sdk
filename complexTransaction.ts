import {
  address,
  Address,
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  createSolanaRpc,
  createNoopSigner,
  type TransactionSigner,
  type IInstruction,
} from '@solana/kit';
import bs58 from 'bs58';

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

import { fetchSettings } from './clients/js/src/generated/accounts/settings';
import { 
  getCreateTransactionInstruction,
  getCreateProposalInstruction,
  getApproveProposalInstruction,
  getExecuteTransactionInstruction,
  getCloseTransactionInstruction,
} from './clients/js/src/generated/instructions';
import { ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS } from './clients/js/src/generated/programs';
import { getSmartAccountTransactionMessageEncoder } from './clients/js/src/generated/types/smartAccountTransactionMessage';
import {
  deriveTransactionPda,
  deriveProposalPda,
  fetchSmartAccountSettings,
  decodeTransactionMessage,
} from './utils/index';

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
  /** Optional: Input token program ID (SPL Token vs Token-2022) for ATA creation */
  inputTokenProgram?: string;
  /** Optional: Pre-derived backend fee account address (ATA) */
  backendFeeAccount?: string;
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
export async function createComplexTransaction(
  params: ComplexTransactionParams
): Promise<ComplexTransactionResult> {
  
  console.log('🚀 Starting createComplexTransaction...');
  console.log('🔍 Params type:', typeof params);
  console.log('🔍 Params is null/undefined:', params == null);
  
  if (params.innerTransactionBytes) {
    console.log('🔍 innerTransactionBytes exists:', true);
    console.log('🔍 innerTransactionBytes type:', typeof params.innerTransactionBytes);
    console.log('🔍 innerTransactionBytes length:', params.innerTransactionBytes.length);
  } else {
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
  
  const {
    rpc,
    smartAccountSettings,
    smartAccountPda,
    smartAccountPdaBump,
    signer,
    feePayer,
    innerTransactionBytes,
    addressTableLookups = [],
    inputTokenMint,
  } = params;
  
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
  const settingsAccount = await fetchSmartAccountSettings(rpc, smartAccountSettings);
  const transactionIndex = settingsAccount.nextTransactionIndex;
  console.log('✅ Settings fetched:', {
    currentTransactionIndex: settingsAccount.currentTransactionIndex.toString(),
    nextTransactionIndex: transactionIndex.toString(),
    threshold: settingsAccount.threshold,
  });

  console.log('🔧 Step 2: Deriving transaction PDA...');
  // 2. Derive the transaction PDA
  const transactionPda = await deriveTransactionPda(smartAccountSettings, transactionIndex);
  console.log('✅ Transaction PDA derived:', transactionPda.toString());

  console.log('🔧 Step 3: Deriving proposal PDA...');
  // 3. Derive the proposal PDA
  const proposalPda = await deriveProposalPda(smartAccountSettings, transactionIndex);
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

  const decodedMessage = decodeTransactionMessage(compiledInnerMessage.messageBytes);
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
  const transactionMessageBytes = getSmartAccountTransactionMessageEncoder().encode(smartAccountMessage);
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
  
  const createTransactionInstruction = getCreateTransactionInstruction({
    settings: smartAccountSettings,
    transaction: transactionPda,
    creator: signer,
    rentPayer: createNoopSigner(feePayer), // Backend pays for transaction account rent
    systemProgram: address('11111111111111111111111111111111'),
    args: {
      accountIndex: 0, // Use 0 for the primary smart account
      accountBump: smartAccountPdaBump,
      ephemeralSigners: 0,
      transactionMessage: transactionMessageBytes,
      memo,
    },
  });

  // 6. Create the proposal instruction
  const createProposalInstruction = getCreateProposalInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    creator: signer,
    rentPayer: createNoopSigner(feePayer), // Backend pays for proposal account rent
    systemProgram: address('11111111111111111111111111111111'),
    transactionIndex: transactionIndex,
    draft: false,
  });

  // 7. Create the approve proposal instruction
  const approveProposalInstruction = getApproveProposalInstruction({
    settings: smartAccountSettings,
    signer: signer,
    proposal: proposalPda,
    systemProgram: address('11111111111111111111111111111111'),
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
  const feePayerSigner = createNoopSigner(feePayer);
  
  const proposeTransactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx), // Use fee payer as real signer for gasless transactions
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(proposeInstructions, tx)
  );

  const compiledProposeTransaction = compileTransaction(proposeTransactionMessage);
  console.log('✅ Part 1 (Propose) transaction compiled:', {
    messageSize: compiledProposeTransaction.messageBytes.length
  });

  // ===== PART 2: VOTE TRANSACTION =====
  console.log('🔧 Building Part 2: Vote Transaction...');

  // Start with the approve proposal instruction
  const voteInstructions: any[] = [approveProposalInstruction];
  
  // Add ATA creation instruction if inputTokenMint is provided (for Jupiter swaps with fees)
  if (inputTokenMint && params.inputTokenProgram && params.backendFeeAccount) {
    console.log('🏦 Creating backend fee account instruction for token:', inputTokenMint, 'at address:', params.backendFeeAccount);
    
    // Constants for ATA creation
    const BACKEND_FEE_PAYER = 'astroi1Rrf6rqtJ1BZg7tDyx1NiUaQkYp3uD8mmTeJQ';
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    const SPL_TOKEN_PROGRAM_ID = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022_PROGRAM_ID = address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    const ASSOCIATED_TOKEN_PROGRAM_ID = address('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111');
    
    // Convert native to WSOL mint
    const actualMint = inputTokenMint === 'native' ? WSOL_MINT : inputTokenMint;
    
    // Determine correct token program
    let tokenProgram: Address = SPL_TOKEN_PROGRAM_ID;
    if (params.inputTokenProgram === 'native') {
      tokenProgram = SPL_TOKEN_PROGRAM_ID;
    } else if (params.inputTokenProgram === TOKEN_2022_PROGRAM_ID.toString()) {
      tokenProgram = TOKEN_2022_PROGRAM_ID;
    } else if (params.inputTokenProgram !== SPL_TOKEN_PROGRAM_ID.toString()) {
      tokenProgram = address(params.inputTokenProgram);
    }
    
    console.log('🔧 Using token program for ATA creation:', tokenProgram.toString());
    
    // Use the pre-derived ATA address from frontend
    const backendFeePayerAddress = address(BACKEND_FEE_PAYER);
    const mintAddress = address(actualMint);
    const backendFeeAccountAddress = address(params.backendFeeAccount);
    
    // Create the ATA creation instruction with correct token program and properly derived ATA address
    const createATAInstruction: IInstruction = {
      programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
      accounts: [
        { address: feePayer, role: AccountRole.WRITABLE_SIGNER }, // Payer for account creation
        { address: backendFeeAccountAddress, role: AccountRole.WRITABLE }, // Properly derived ATA address
        { address: backendFeePayerAddress, role: AccountRole.READONLY }, // Owner of the ATA
        { address: mintAddress, role: AccountRole.READONLY }, // Token mint
        { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY }, // System program
        { address: tokenProgram, role: AccountRole.READONLY }, // Correct token program (SPL Token or Token-2022)
      ],
      data: new Uint8Array([1]), // ATA idempotent creation instruction discriminator
    };
    
    voteInstructions.push(createATAInstruction as any);
    console.log('✅ Added backend fee account creation to vote transaction for ATA:', params.backendFeeAccount);
  }

  const voteTransactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx), // Use fee payer as real signer for gasless transactions
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(voteInstructions, tx)
  );

  const compiledVoteTransaction = compileTransaction(voteTransactionMessage);
  console.log('✅ Part 2 (Vote) transaction compiled:', {
    messageSize: compiledVoteTransaction.messageBytes.length
  });

  // ===== PART 3: EXECUTE TRANSACTION =====
  console.log('🔧 Building Part 3: Execute Transaction...');

  // Create the execute transaction instruction
  const executeTransactionInstruction = getExecuteTransactionInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    transaction: transactionPda,
    signer: signer,
  });

  // Create close instruction to reclaim rent back to fee payer
  const closeTransactionInstruction = getCloseTransactionInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    transaction: transactionPda,
    proposalRentCollector: feePayer, // Rent goes back to backend fee payer
    transactionRentCollector: feePayer, // Rent goes back to backend fee payer
    systemProgram: address('11111111111111111111111111111111'),
  });

  // The smart contract expects manual ALT resolution via remaining accounts (message_account_infos).
  // We must pass:
  // 1) All static accounts from the inner message in the exact order they appear.
  // 2) All ALT-resolved writable addresses (in order), then readonly addresses (in order) for each ALT.
  // We should NOT include the ALT table account itself.
  
  console.log('🔧🔧🔧 EXECUTE TRANSACTION ACCOUNT SETUP STARTING 🔧🔧🔧');
  console.log('🔧 Smart contract expects manual ALT resolution');
  console.log('🔍 addressTableLookups exists:', !!addressTableLookups);
  console.log('🔍 addressTableLookups type:', typeof addressTableLookups);
  console.log('🔍 addressTableLookups length:', addressTableLookups?.length || 0);
  console.log('🔍 addressTableLookups:', JSON.stringify(addressTableLookups || [], null, 2));
  console.log('🔍 Static accounts:', decodedMessage.staticAccounts?.length || 0);
  
  // Build remaining accounts precisely and in-order.
  const explicitParamsCount = 4; // settings, proposal, transaction, signer
  const explicitParams = executeTransactionInstruction.accounts.slice(0, explicitParamsCount);
  const resultAccounts: { address: Address; role: AccountRole }[] = [];

  // Static accounts writability derived from header
  const hdr = decodedMessage.header;
  const total = decodedMessage.staticAccounts.length;
  const numSignersInner = hdr.numSignerAccounts;
  const numWritableSignersInner = numSignersInner - hdr.numReadonlySignerAccounts;
  const numWritableNonSignersInner = total - numSignersInner - hdr.numReadonlyNonSignerAccounts;

  // 1) ALT table accounts first (if any)
  if (addressTableLookups && addressTableLookups.length > 0) {
    for (const lookup of addressTableLookups) {
      resultAccounts.push({ address: lookup.accountKey, role: AccountRole.READONLY });
    }
  }

  // 2) Static accounts in order with correct roles
  decodedMessage.staticAccounts.forEach((addrKey: Address, idx: number) => {
    let role = AccountRole.READONLY;
    if (idx < numSignersInner) {
      role = idx < numWritableSignersInner ? AccountRole.WRITABLE : AccountRole.READONLY;
    } else {
      const j = idx - numSignersInner;
      role = j < numWritableNonSignersInner ? AccountRole.WRITABLE : AccountRole.READONLY;
    }
    resultAccounts.push({ address: addrKey, role });
  });

  // 3) ALT-resolved: writable indexes then readonly indexes for each table
  if (addressTableLookups && addressTableLookups.length > 0) {
    for (const lookup of addressTableLookups) {
      const altAccountInfo = await rpc.getAccountInfo(lookup.accountKey, {
        encoding: 'base64',
        commitment: 'finalized',
      }).send();
      if (!altAccountInfo.value?.data) throw new Error('ALT not found');
      const altDataBase64 = Array.isArray(altAccountInfo.value.data)
        ? altAccountInfo.value.data[0]
        : (altAccountInfo.value.data as string);
      const altData = Buffer.from(altDataBase64, 'base64');
      const HEADER_SIZE = 56;
      const PUBKEY_SIZE = 32;
      const totalAddresses = Math.floor((altData.length - HEADER_SIZE) / PUBKEY_SIZE);
      const getAddressAtIndex = (index: number): Address => {
        if (index >= totalAddresses) throw new Error('ALT index OOB');
        const offset = HEADER_SIZE + index * PUBKEY_SIZE;
        const pubkeyBytes = altData.subarray(offset, offset + PUBKEY_SIZE);
        return address(bs58.encode(pubkeyBytes));
      };
      for (const writableIndex of (lookup.writableIndexes || [])) {
        resultAccounts.push({ address: getAddressAtIndex(writableIndex), role: AccountRole.WRITABLE });
      }
      for (const readonlyIndex of (lookup.readonlyIndexes || [])) {
        resultAccounts.push({ address: getAddressAtIndex(readonlyIndex), role: AccountRole.READONLY });
      }
    }
  }

  // Rebuild execute instruction accounts: explicit params + precise remaining accounts in expected order
  Object.assign(executeTransactionInstruction, {
    accounts: [...explicitParams, ...resultAccounts],
  });
  
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

  const executeTransactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx), // Use fee payer as real signer for gasless transactions
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions(executeInstructions, tx)
  );

  const compiledExecuteTransaction = compileTransaction(executeTransactionMessage);
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
