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

type SolanaRpc = ReturnType<typeof createSolanaRpc>;

import {
  getCreateTransactionBufferInstruction,
  getExtendTransactionBufferInstruction,
  getCreateTransactionFromBufferInstruction,
  getCreateTransactionFromBufferInstructionDataDecoder,
  getCreateProposalInstruction,
  getApproveProposalInstruction,
  getExecuteTransactionInstruction,
  getCloseTransactionBufferInstruction,
} from './clients/js/src/generated/instructions';
import { getSmartAccountTransactionMessageEncoder } from './clients/js/src/generated/types/smartAccountTransactionMessage';
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

  // CRITICAL FIX: Store raw Jupiter transaction bytes in buffer
  // The Solana program expects standard TransactionMessage format, not custom SmartAccount format
  console.log('🔧 Storing raw Jupiter transaction bytes in buffer (standard format)');
  console.log('🔍 Raw Jupiter transaction length:', innerTransactionBytes.length);
  
  const messageBytes = innerTransactionBytes; // Use Jupiter's raw transaction bytes directly

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

  const createBufferMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    tx => appendTransactionMessageInstructions([createBufferIx], tx)
  );
  const createBufferTx = new Uint8Array(compileTransaction(createBufferMessage).messageBytes);

  // Log the buffer creation transaction (for txWireframe.ts analysis)
  console.log('🔍 Phase 1 - Buffer Creation Transaction (base64):');
  console.log(Buffer.from(createBufferTx).toString('base64'));

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

