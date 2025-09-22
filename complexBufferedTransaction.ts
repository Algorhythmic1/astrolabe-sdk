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
  compressTransactionMessageUsingAddressLookupTables,
  createSolanaRpc,
  createNoopSigner,
  getProgramDerivedAddress,
  type TransactionSigner,
} from '@solana/kit';
import bs58 from 'bs58';
import { 
  getStructEncoder,
  getU8Encoder,
  getArrayEncoder,
  getBytesEncoder,
  getAddressEncoder,
  fixEncoderSize,
  getU32Encoder,
  addEncoderSizePrefix
} from '@solana/kit';

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

import {
  getCreateTransactionBufferInstruction,
  getCreateTransactionBufferInstructionDataDecoder,
  getExtendTransactionBufferInstruction,
  getCreateTransactionFromBufferInstruction,
  getCreateTransactionFromBufferInstructionDataDecoder,
  getCreateTransactionFromBufferInstructionDataEncoder,
  getCreateProposalInstruction,
  getApproveProposalInstruction,
  getExecuteTransactionInstruction,
  getCloseTransactionBufferInstruction,
} from './clients/js/src/generated/instructions';
import { getSmartAccountTransactionMessageEncoder, getSmartAccountTransactionMessageDecoder } from './clients/js/src/generated/types/smartAccountTransactionMessage';
import { fetchSettings } from './clients/js/src/generated/accounts/settings';
import { deriveTransactionPda, deriveProposalPda, decodeTransactionMessage } from './utils/index';
import { ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS } from './clients/js/src/generated/programs';

export interface BufferedTransactionParams {
  rpc: SolanaRpc;
  smartAccountSettings: Address;
  smartAccountPda: Address;
  smartAccountPdaBump: number;
  signer: TransactionSigner;
  feePayer: Address;
  innerTransactionBytes: Uint8Array;
  addressTableLookups?: any[];
  memo?: string;
  bufferIndex?: number; // 0..255
  accountIndex?: number; // usually 0
}

export interface BufferedTransactionResult {
  createBufferTx: Uint8Array[]; // first + extends (multiple tx messages)
  createFromBufferTx: Uint8Array;
  approveTx: Uint8Array;
  executeTx: Uint8Array;
  closeBufferTx?: Uint8Array;
  transactionPda: Address;
  proposalPda: Address;
}

export async function createComplexBufferedTransaction(params: BufferedTransactionParams): Promise<BufferedTransactionResult> {
  const {
    rpc,
    smartAccountSettings,
    smartAccountPda,
    smartAccountPdaBump,
    signer,
    feePayer,
    innerTransactionBytes,
    addressTableLookups = [],
    memo = 'Buffered Smart Account Transaction',
    bufferIndex = 0,
    accountIndex = 0,
  } = params;

  // Derive PDAs and fetch settings
  const settings = await fetchSettings(rpc, smartAccountSettings);
  const nextIndex = settings.data.transactionIndex + 1n;
  const transactionPda = await deriveTransactionPda(smartAccountSettings, nextIndex);
  const proposalPda = await deriveProposalPda(smartAccountSettings, nextIndex);

  // CRITICAL FIX: Convert Jupiter's standard format to SmartAccount format with ALT support
  // The program expects custom TransactionMessage format that includes address_table_lookups
  console.log('🔧 Converting Jupiter transaction to SmartAccount format with ALT support');
  console.log('🔍 Raw Jupiter transaction length:', innerTransactionBytes.length);
  console.log('🔍 ALT count:', addressTableLookups.length);
  
  // Decode the standard transaction message from Jupiter
  const decoded = decodeTransactionMessage(innerTransactionBytes);
  
  // Convert from Solana's standard format to SmartAccount format
  const numSigners = decoded.header.numSignerAccounts;
  const numReadonlySigners = decoded.header.numReadonlySignerAccounts;
  const numWritableSigners = numSigners - numReadonlySigners;
  const numWritableNonSigners = decoded.staticAccounts.length - numSigners - decoded.header.numReadonlyNonSignerAccounts;
  
  // Convert instructions from standard format to SmartAccount format
  const smartAccountInstructions = decoded.instructions.map(ix => ({
    programIdIndex: ix.programAddressIndex, // Convert field name
    accountIndexes: new Uint8Array(ix.accountIndices || []), // Convert field name  
    data: new Uint8Array(ix.data || [])
  }));
  
  // Convert address table lookups to SmartAccount format (keep ALTs!)
  const smartAccountLookups = addressTableLookups.map(lookup => ({
    accountKey: typeof lookup.accountKey === 'string' ? address(lookup.accountKey) : lookup.accountKey,
    writableIndexes: new Uint8Array(lookup.writableIndexes || []),
    readonlyIndexes: new Uint8Array(lookup.readonlyIndexes || [])
  }));
  
  // Create the SmartAccount format message WITH ALT support
  const smartAccountMessage = {
    numSigners,
    numWritableSigners,
    numWritableNonSigners,
    accountKeys: decoded.staticAccounts.map(addr => typeof addr === 'string' ? address(addr) : addr),
    instructions: smartAccountInstructions,
    addressTableLookups: smartAccountLookups // ALTs preserved!
  };
  
  // Use the generated encoder to properly serialize in SmartAccount format
  const jsSdkMessageBytes = getSmartAccountTransactionMessageEncoder().encode(smartAccountMessage);
  
  // 🚨 CRITICAL DEBUG: Test if we can decode our own encoded message
  try {
    const decoder = getSmartAccountTransactionMessageDecoder();
    const testDecoded = decoder.decode(jsSdkMessageBytes);
    console.log('✅ SELF-DECODE TEST PASSED - Our encoding is valid!');
    console.log('🔍 Decoded back:', {
      numSigners: testDecoded.numSigners,
      numWritableSigners: testDecoded.numWritableSigners,
      numWritableNonSigners: testDecoded.numWritableNonSigners,
      accountKeysCount: testDecoded.accountKeys.length,
      instructionsCount: testDecoded.instructions.length,
      altLookupsCount: testDecoded.addressTableLookups.length
    });
  } catch (err) {
    console.error('❌ SELF-DECODE TEST FAILED - Our encoding is BROKEN!', err);
    throw err;
  }
  
  // Let's debug the ACTUAL difference between JS SDK bytes and Jupiter bytes
  console.log('🔍 Analyzing transaction message formats:');
  console.log('📊 JS SDK message bytes (first 100):', Array.from(jsSdkMessageBytes.slice(0, 100)));
  console.log('📊 Raw Jupiter bytes (first 100):', Array.from(innerTransactionBytes.slice(0, 100)));
  
  // Let's also check what the create_transaction instruction expects
  console.log('🔍 SmartAccount message structure:');
  console.log('  numSigners:', smartAccountMessage.numSigners);
  console.log('  numWritableSigners:', smartAccountMessage.numWritableSigners);
  console.log('  numWritableNonSigners:', smartAccountMessage.numWritableNonSigners);
  console.log('  accountKeys length:', smartAccountMessage.accountKeys.length);
  console.log('  instructions length:', smartAccountMessage.instructions.length);
  console.log('  addressTableLookups length:', smartAccountMessage.addressTableLookups.length);
  
  if (smartAccountMessage.instructions.length > 0) {
    console.log('  first instruction:', {
      programIdIndex: smartAccountMessage.instructions[0].programIdIndex,
      accountIndexes: smartAccountMessage.instructions[0].accountIndexes.length,
      data: smartAccountMessage.instructions[0].data.length
    });
  }
  
  // Use the JS SDK generated encoder - it should work!
  const messageBytes = jsSdkMessageBytes;
  
  console.log('✅ SmartAccount transaction with ALTs created:', {
    staticAccounts: decoded.staticAccounts.length,
    altLookups: smartAccountLookups.length,
    messageSize: messageBytes.length,
    preservedCompression: true
  });

  // Log the transaction message being stored (for txWireframe.ts analysis)
  console.log('🔍 Manual TransactionMessage for Buffer:');
  console.log(Buffer.from(messageBytes).toString('base64'));

  // Final buffer hash/size
  const finalBuffer = new Uint8Array(messageBytes);
  const finalBufferSize = finalBuffer.length;
  // Simple hash: use sha256 from Web Crypto
  const hashBuf = await crypto.subtle.digest('SHA-256', finalBuffer as unknown as ArrayBuffer);
  const finalBufferHash = new Uint8Array(hashBuf);

  const feePayerSigner = createNoopSigner(feePayer);
  const latestBlockhash = (await rpc.getLatestBlockhash().send()).value;

  // Chunk the buffer (e.g., 900 bytes per tx to be safe)
  const CHUNK = 900;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < finalBuffer.length; i += CHUNK) {
    chunks.push(finalBuffer.subarray(i, Math.min(i + CHUNK, finalBuffer.length)));
  }
  
  console.log('🔍 Buffer chunking analysis:');
  console.log('  finalBuffer.length:', finalBuffer.length);
  console.log('  CHUNK size:', CHUNK);
  console.log('  chunks.length:', chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    console.log(`  chunk[${i}] size:`, chunks[i].length);
  }

  // Derive a free transaction_buffer PDA by probing indices.
  async function deriveBufferPda(idx: number) {
    const [pda] = await getProgramDerivedAddress({
      programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
      seeds: [
        new Uint8Array(Buffer.from('smart_account')),
        bs58.decode(smartAccountSettings),
        new Uint8Array(Buffer.from('transaction_buffer')),
        bs58.decode(signer.address as string),
        new Uint8Array([idx & 0xff]),
      ],
    });
    return pda;
  }
  let chosenBufferIndex = bufferIndex & 0xff;
  let transactionBufferPda = await deriveBufferPda(chosenBufferIndex);
  for (let attempts = 0; attempts < 256; attempts++) {
    const info = await rpc.getAccountInfo(transactionBufferPda, { commitment: 'processed' as any }).send();
    if (!info.value) break; // free
    chosenBufferIndex = (chosenBufferIndex + 1) & 0xff;
    transactionBufferPda = await deriveBufferPda(chosenBufferIndex);
  }

  // 1) create_transaction_buffer with first slice
  console.log('🔍 CRITICAL DEBUG - CreateTransactionBuffer parameters:');
  console.log('  finalBufferSize (before call):', finalBufferSize, 'type:', typeof finalBufferSize);
  console.log('  chunks[0].length:', chunks[0].length, 'type:', typeof chunks[0].length);
  console.log('  bufferIndex:', chosenBufferIndex, 'type:', typeof chosenBufferIndex);
  console.log('  accountIndex:', accountIndex, 'type:', typeof accountIndex);
  console.log('  finalBufferHash.length:', finalBufferHash.length);
  
  const createBufferIx = getCreateTransactionBufferInstruction({
    settings: smartAccountSettings,
    transactionBuffer: transactionBufferPda,
    creator: signer,
    rentPayer: feePayerSigner,
    systemProgram: address('11111111111111111111111111111111'),
    bufferIndex: chosenBufferIndex,
    accountIndex,
    finalBufferHash,
    finalBufferSize,
    buffer: chunks[0],
  });
  
  console.log('🔍 CRITICAL DEBUG - After instruction creation:');
  console.log('  createBufferIx.data.length:', createBufferIx.data.length);
  
  // Let's also decode the instruction data to see what values actually got encoded
  try {
    const decoder = getCreateTransactionBufferInstructionDataDecoder();
    const decoded = decoder.decode(createBufferIx.data);
    console.log('🔍 DECODED instruction data:');
    console.log('  decoded.finalBufferSize:', decoded.finalBufferSize, 'type:', typeof decoded.finalBufferSize);
    console.log('  decoded.buffer.length:', decoded.buffer.length, 'type:', typeof decoded.buffer.length);
    console.log('  decoded.bufferIndex:', decoded.bufferIndex);
    console.log('  decoded.accountIndex:', decoded.accountIndex);
    
    if (decoded.finalBufferSize !== finalBufferSize) {
      console.error('❌ CRITICAL BUG: finalBufferSize got corrupted during instruction encoding!');
      console.error('   Expected:', finalBufferSize, 'Got:', decoded.finalBufferSize);
    }
    if (decoded.buffer.length !== chunks[0].length) {
      console.error('❌ CRITICAL BUG: buffer length got corrupted during instruction encoding!');
      console.error('   Expected:', chunks[0].length, 'Got:', decoded.buffer.length);
    }
  } catch (decodeErr) {
    console.error('❌ Failed to decode instruction data:', decodeErr);
  }

  const createBufferMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstructions([createBufferIx], tx)
  );
  
  console.log('🔍 CreateTransactionBuffer transaction analysis:');
  console.log('  chunk[0] size being stored:', chunks[0].length);
  console.log('  finalBufferSize parameter:', finalBufferSize);
  console.log('  createBufferIx.data.length:', createBufferIx.data.length);
  console.log('  createBufferMessage size:', compileTransaction(createBufferMessage).messageBytes.length);
  
  // Check if the transaction size exceeds limits
  const compiledSize = compileTransaction(createBufferMessage).messageBytes.length;
  if (compiledSize > 1232) {
    console.error('❌ CRITICAL: CreateTransactionBuffer transaction exceeds 1232 byte limit!');
    console.error('   Transaction size:', compiledSize);
    console.error('   This will cause data truncation!');
  }
  const createBufferTx = new Uint8Array(compileTransaction(createBufferMessage).messageBytes);

  // Log the buffer creation transaction (for txWireframe.ts analysis)
  console.log('🔍 Phase 1 - Buffer Creation Transaction (base64):');
  console.log(Buffer.from(createBufferTx).toString('base64'));
  
  // CRITICAL: Let's manually decode the base64 transaction to verify the buffer data survives encoding
  console.log('🔍 CRITICAL: Manual verification of base64 transaction data');
  const base64Tx = Buffer.from(createBufferTx).toString('base64');
  const decodedTxBytes = Buffer.from(base64Tx, 'base64');
  console.log('  Original tx bytes length:', createBufferTx.length);
  console.log('  Base64 length:', base64Tx.length);  
  console.log('  Decoded tx bytes length:', decodedTxBytes.length);
  console.log('  Round-trip successful:', Buffer.compare(new Uint8Array(createBufferTx), new Uint8Array(decodedTxBytes)) === 0);
  
  // Find the instruction data within the transaction and verify the buffer content
  // This will help us confirm that 724 bytes are intact even in the final transaction
  const createBufferIxDataHex = Buffer.from(createBufferIx.data).toString('hex');
  const fullTxHex = Buffer.from(createBufferTx).toString('hex');
  const ixDataIndex = fullTxHex.indexOf(createBufferIxDataHex.substring(0, 50)); // Find first part of instruction
  if (ixDataIndex >= 0) {
    console.log('✅ Instruction data found in final transaction at position:', Math.floor(ixDataIndex / 2));
    const extractedIxHex = fullTxHex.substring(ixDataIndex, ixDataIndex + createBufferIxDataHex.length);
    console.log('  Instruction data matches:', extractedIxHex === createBufferIxDataHex);
  } else {
    console.error('❌ Could not find instruction data in final transaction - this indicates corruption!');
  }

  // 2) extend_transaction_buffer for remaining slices
  const extendTxs: Uint8Array[] = [];
  for (let i = 1; i < chunks.length; i++) {
    const extendIx = getExtendTransactionBufferInstruction({
      settings: smartAccountSettings,
      transactionBuffer: transactionBufferPda,
      creator: signer,
      buffer: chunks[i],
    });
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
      tx => appendTransactionMessageInstructions([extendIx], tx)
    );
    extendTxs.push(new Uint8Array(compileTransaction(msg).messageBytes));
  }

  // 3) create_transaction_from_buffer + create_proposal + approve
  
  // Debug parameters BEFORE validation
  console.log('🚨 DEBUG: smartAccountPdaBump parameter value:', smartAccountPdaBump, 'type:', typeof smartAccountPdaBump);
  console.log('🚨 DEBUG: accountIndex parameter value:', accountIndex, 'type:', typeof accountIndex);
  console.log('🚨 DEBUG: memo parameter value:', memo, 'type:', typeof memo);
  console.log('🚨 DEBUG: smartAccountSettings:', smartAccountSettings);
  console.log('🚨 DEBUG: smartAccountPda:', smartAccountPda);
  
  // Check for undefined/null values that might cause encoding issues
  if (smartAccountPdaBump === undefined || smartAccountPdaBump === null) {
    console.error('❌ CRITICAL: smartAccountPdaBump is undefined/null!');
  }
  if (accountIndex === undefined || accountIndex === null) {
    console.error('❌ CRITICAL: accountIndex is undefined/null!');
  }
  
  // Validate u8 values to prevent BorshIoError
  if (typeof accountIndex !== 'number' || accountIndex < 0 || accountIndex > 255) {
    throw new Error(`Invalid accountIndex: ${accountIndex} (must be u8)`);
  }
  if (typeof smartAccountPdaBump !== 'number' || smartAccountPdaBump < 0 || smartAccountPdaBump > 255) {
    throw new Error(`Invalid smartAccountPdaBump: ${smartAccountPdaBump} (must be valid PDA bump 0-255, got ${smartAccountPdaBump})`);
  }
  
  // Debug the instruction arguments before encoding
  console.log('🔍 CreateTransactionFromBuffer args will be:', {
    accountIndex: accountIndex & 0xFF,
    accountBump: smartAccountPdaBump & 0xFF,
    ephemeralSigners: 0,
    transactionMessage: Array.from(new Uint8Array([0, 0, 0, 0, 0, 0])),
    memo: memo || null,
    bufferIndex: chosenBufferIndex & 0xFF,
  });
  
  // Use the generated instruction function with exact same args structure as working transactions
  const createFromBufferIx = getCreateTransactionFromBufferInstruction({
    settings: smartAccountSettings,
    transaction: transactionPda,
    transactionCreator: signer,
    rentPayer: feePayerSigner,
    systemProgram: address('11111111111111111111111111111111'),
    transactionBuffer: transactionBufferPda,
    creator: signer,
    args: {
      accountIndex: accountIndex & 0xFF,
      accountBump: smartAccountPdaBump & 0xFF,
      ephemeralSigners: 0,
      transactionMessage: new Uint8Array([0, 0, 0, 0, 0, 0]),
      memo: memo || null,
      bufferIndex: chosenBufferIndex & 0xFF, // Add the buffer index to fix circular dependency
    },
  });
  
  // Debug the instruction data
  console.log('🔍 CreateTransactionFromBuffer instruction data length:', createFromBufferIx.data.length);
  console.log('🔍 CreateTransactionFromBuffer instruction data first 32 bytes:', Array.from(createFromBufferIx.data.slice(0, 32)));
  console.log('🔍 CreateTransactionFromBuffer instruction data as hex:', Buffer.from(createFromBufferIx.data).toString('hex'));
  
  // Test if we can decode our own instruction data
  try {
    const decoded = getCreateTransactionFromBufferInstructionDataDecoder().decode(createFromBufferIx.data);
    console.log('✅ SDK can decode instruction data:', decoded);
    
    // Extra debugging - validate the actual values being passed
    console.log('🔍 Detailed instruction validation:');
    console.log('  accountIndex (raw):', accountIndex, 'masked:', accountIndex & 0xFF);
    console.log('  smartAccountPdaBump (raw):', smartAccountPdaBump, 'masked:', smartAccountPdaBump & 0xFF);
    console.log('  transactionMessage length:', new Uint8Array([0, 0, 0, 0, 0, 0]).length);
    console.log('  memo type:', typeof memo, 'value:', memo);
    
    // Verify the decoded values match what we expect
    if (decoded.args.accountIndex !== (accountIndex & 0xFF)) {
      console.error('❌ accountIndex mismatch! expected:', accountIndex & 0xFF, 'got:', decoded.args.accountIndex);
    }
    if (decoded.args.accountBump !== (smartAccountPdaBump & 0xFF)) {
      console.error('❌ accountBump mismatch! expected:', smartAccountPdaBump & 0xFF, 'got:', decoded.args.accountBump);
    }
    if (Array.from(decoded.args.transactionMessage).join(',') !== '0,0,0,0,0,0') {
      console.error('❌ transactionMessage mismatch! expected: 0,0,0,0,0,0 got:', Array.from(decoded.args.transactionMessage).join(','));
    }
    
  } catch (err) {
    console.error('❌ SDK cannot decode its own instruction data:', err);
    console.error('❌ This suggests a serious encoding problem with the following values:');
    console.error('  accountIndex:', accountIndex, '(type:', typeof accountIndex, ')');
    console.error('  smartAccountPdaBump:', smartAccountPdaBump, '(type:', typeof smartAccountPdaBump, ')');
    console.error('  memo:', memo, '(type:', typeof memo, ')');
    
    // Let's test manual encoding to isolate the issue
    console.log('🧪 Testing manual encoding of instruction data...');
    try {
      const testArgsData = {
        args: {
          accountIndex: accountIndex & 0xFF,
          accountBump: smartAccountPdaBump & 0xFF,
          ephemeralSigners: 0,
          transactionMessage: new Uint8Array([0, 0, 0, 0, 0, 0]),
          memo: memo || null,
          bufferIndex: chosenBufferIndex & 0xFF,
        }
      };
      
      const encoder = getCreateTransactionFromBufferInstructionDataEncoder();
      const manualBytes = encoder.encode(testArgsData);
      console.log('✅ Manual encoding succeeded, length:', manualBytes.length);
      console.log('🔍 Manual bytes (first 50):', Array.from(manualBytes.slice(0, 50)));
      
      // Try to decode our manual encoding
      const decoder = getCreateTransactionFromBufferInstructionDataDecoder();
      const manualDecoded = decoder.decode(manualBytes);
      console.log('✅ Manual decode succeeded:', manualDecoded);
      
      // Compare manual vs generated instruction bytes
      console.log('🔍 COMPARISON:');
      console.log('  Generated instruction bytes (first 50):', Array.from(createFromBufferIx.data.slice(0, 50)));
      console.log('  Manual encoded bytes    (first 50):', Array.from(manualBytes.slice(0, 50)));
      console.log('  Bytes match:', Array.from(createFromBufferIx.data.slice(0, 50)).join(',') === Array.from(manualBytes.slice(0, 50)).join(','));
      
    } catch (manualErr) {
      console.error('❌ Manual encoding ALSO failed:', manualErr);
      console.error('❌ This suggests a fundamental issue with our argument values or types');
    }
  }

  const createProposalIx = getCreateProposalInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    creator: signer,
    rentPayer: feePayerSigner,
    systemProgram: address('11111111111111111111111111111111'),
    transactionIndex: nextIndex,
    draft: false,
  });

  const approveIx = getApproveProposalInstruction({
    settings: smartAccountSettings,
    signer,
    proposal: proposalPda,
    systemProgram: address('11111111111111111111111111111111'),
    args: { memo: null },
  });

  const createFromBufferMsg = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstructions([createFromBufferIx, createProposalIx, approveIx], tx)
  );
  const createFromBufferTx = new Uint8Array(compileTransaction(createFromBufferMsg).messageBytes);

  // Log the create from buffer transaction (for txWireframe.ts analysis)
  console.log('🔍 Phase 2a - Create From Buffer Transaction (base64):');
  console.log(Buffer.from(createFromBufferTx).toString('base64'));

  // 4) execute (reuse existing execute assembly) + close buffer in the same tx
  const executeIx = getExecuteTransactionInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    transaction: transactionPda,
    signer,
  });
  const closeBufferIx = getCloseTransactionBufferInstruction({
    settings: smartAccountSettings,
    transactionBuffer: transactionBufferPda,
    creator: signer,
  });
  let executeMsg = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstructions([executeIx, closeBufferIx], tx)
  );
  if (addressTableLookups.length > 0) {
    const addressesByLookupTableAddress: Record<string, Address[]> = {};
    for (const lookup of addressTableLookups) {
      const info = await rpc.getAccountInfo(lookup.accountKey, { encoding: 'base64', commitment: 'finalized' }).send();
      if (!info.value?.data) continue;
      const b64 = Array.isArray(info.value.data) ? info.value.data[0] : (info.value.data as string);
      const dataBuf = Buffer.from(b64, 'base64');
      const data = new Uint8Array(dataBuf.buffer, dataBuf.byteOffset, dataBuf.byteLength);
      const HEADER_SIZE = 56;
      const PUBKEY_SIZE = 32;
      const total = Math.floor((data.length - HEADER_SIZE) / PUBKEY_SIZE);
      const addrs: Address[] = [];
      for (let i = 0; i < total; i++) {
        const off = HEADER_SIZE + i * PUBKEY_SIZE;
        const keyBytes = data.subarray(off, off + PUBKEY_SIZE);
        addrs.push(address(bs58.encode(keyBytes)));
      }
      addressesByLookupTableAddress[lookup.accountKey.toString()] = addrs;
    }
    executeMsg = compressTransactionMessageUsingAddressLookupTables(executeMsg as any, addressesByLookupTableAddress as any) as any;
  }
  const executeTx = new Uint8Array(compileTransaction(executeMsg).messageBytes);

  // Log the execute transaction (for txWireframe.ts analysis)
  console.log('🔍 Phase 2b - Execute Transaction (base64):');
  console.log(Buffer.from(executeTx).toString('base64'));

  return {
    createBufferTx: [createBufferTx, ...extendTxs],
    createFromBufferTx,
    approveTx: createFromBufferTx, // includes approve in same tx
    executeTx,
    transactionPda,
    proposalPda,
  };
}

