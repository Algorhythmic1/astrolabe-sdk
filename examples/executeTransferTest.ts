import {
  pipe,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  sendAndConfirmTransactionFactory,
  lamports,
  address,
  getProgramDerivedAddress,
  createNoopSigner,
  compileTransaction,
  getCompiledTransactionMessageDecoder,
  getStructEncoder,
  getU8Encoder,
  getBytesEncoder,
  getOptionEncoder,
  addEncoderSizePrefix,
  fixEncoderSize,
  getUtf8Encoder,
  getU32Encoder,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import fs from 'fs';
import {
  ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
} from '../clients/js/src/generated/programs';
import { Buffer } from 'buffer';
import { fetchSettings, fetchTransaction } from '../clients/js/src/generated/accounts';
import bs58 from 'bs58';
import {
  getCreateProposalInstruction,
  getApproveProposalInstruction,
  getExecuteTransactionInstruction,
} from '../clients/js/src/generated/instructions';
import { VoteOnProposalArgs } from '../clients/js/src/generated/types';
import { AccountRole } from '@solana/kit';
import assert from 'assert';
import { getSmartAccountTransactionMessageEncoder } from '../clients/js/src/generated/types/smartAccountTransactionMessage';
import { 
  getCreateTransactionInstruction,
} from '../clients/js/src/generated/instructions';

async function main() {
  // Set up connection
  const rpc = createSolanaRpc('http://localhost:8899');
  const rpcSubscriptions = createSolanaRpcSubscriptions('ws://localhost:8900');
  
  // Use a consistent creator and fee payer
  const feePayerKeypairFile = fs.readFileSync('/Users/algorhythmic/.config/solana/id.json');
  const feePayerKeypairBytes = new Uint8Array(JSON.parse(feePayerKeypairFile.toString()));
  const feePayerKeypair = await createKeyPairFromBytes(feePayerKeypairBytes);
  const feePayer = await createSignerFromKeyPair(feePayerKeypair);

  // The PDA for the smart account that was created in the previous script.
  const smartAccountSettings = address('Gb6dotbmh811jfxUA4iUtZGByp7Dhg7BQ7xJRekqLq9i');

  // This is the PDA that will SIGN the inner transaction. It must also hold the funds.
  const [smartAccountPda, smartAccountPdaBump] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
        new Uint8Array(Buffer.from('smart_account')),
        bs58.decode(smartAccountSettings),
        new Uint8Array(Buffer.from('smart_account')),
        new Uint8Array([1]), // account_index
    ]
  });

  const airdropAmount = lamports(2_000_000_000n); // 2 SOL

  console.log(
    `Airdropping ${airdropAmount} lamports to smart account signer: ${smartAccountPda}`
  );

  // Airdrop funds to the smart account wallet
  const airdropIx = getTransferSolInstruction({
    source: feePayer,
    destination: smartAccountPda,
    amount: airdropAmount,
  });

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayer, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([airdropIx], tx)
  );

  const signedAirdropTransaction =
    await signTransactionMessageWithSigners(transactionMessage);

  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedAirdropTransaction, { commitment: 'confirmed' });

  console.log(
    `Airdrop successful. Signature: ${getSignatureFromTransaction(
      signedAirdropTransaction
    )}`
  );

  // --- Create Proposal ---
  console.log('\n--- Creating transaction proposal ---');

  // 1. Fetch the latest on-chain state for the Settings account
  const settings = await fetchSettings(rpc, smartAccountSettings);
  const transactionIndex = settings.data.transactionIndex + 1n;
  console.log(`Current transaction index: ${settings.data.transactionIndex}, new index: ${transactionIndex}`);

  // 2. Derive the PDA for the new Transaction account
  const [transactionPda] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
        new Uint8Array(Buffer.from('smart_account')),
        bs58.decode(smartAccountSettings),
        new Uint8Array(Buffer.from('transaction')),
        new Uint8Array(new BigUint64Array([transactionIndex]).buffer),
    ]
  });
  console.log(`Transaction PDA: ${transactionPda}`);

  // 3. Create the instruction that the multisig will execute (1 SOL transfer)
  const transferIx = getTransferSolInstruction({
    source: createNoopSigner(smartAccountPda),
    destination: feePayer.address,
    amount: lamports(1_000_000_000n), // 1 SOL
  });

  // 4. Build and ENCODE the inner transaction message
  const { value: latestBlockhashForTransfer } = await rpc.getLatestBlockhash().send();
  const transferMessage = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(createNoopSigner(smartAccountPda), tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhashForTransfer, tx),
    tx => appendTransactionMessageInstructions([transferIx], tx)
  );

  const compiledTransferMessage = compileTransaction(transferMessage);
  const decodedMessage = getCompiledTransactionMessageDecoder().decode(compiledTransferMessage.messageBytes);

  // Manually construct the argument for the encoder. This is what the program expects.
  const smartAccountMessage = {
    numSigners: 1,
    numWritableSigners: 1,
    numWritableNonSigners: 1,
    accountKeys: decodedMessage.staticAccounts,
    instructions: decodedMessage.instructions.map(ix => ({
      programIdIndex: ix.programAddressIndex,
      accountIndexes: new Uint8Array(ix.accountIndices ?? []),
      data: ix.data ?? new Uint8Array(),
    })),
    addressTableLookups: [],
  };

  const transactionMessageBytes = getSmartAccountTransactionMessageEncoder().encode(smartAccountMessage);

  // 5. Build the instruction to create the transaction account
  const createTransactionInstruction = getCreateTransactionInstruction({
    settings: smartAccountSettings,
    transaction: transactionPda,
    creator: feePayer,
    rentPayer: feePayer,
    systemProgram: address('11111111111111111111111111111111'),
    args: {
        accountIndex: 0,
        accountBump: smartAccountPdaBump,
        ephemeralSigners: 0,
        transactionMessage: transactionMessageBytes,
        memo: 'Transfer 1 SOL to creator',
    }
  });

  // 6. Build, sign, and send the transaction to create the on-chain transaction data
  console.log('Sending create transaction instruction...');
  const { value: latestBlockhashForCreateTx } = await rpc.getLatestBlockhash().send();
  const createTransactionTx = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhashForCreateTx, tx),
    tx => appendTransactionMessageInstructions([createTransactionInstruction], tx)
  );

  const signedCreateTransactionTx = await signTransactionMessageWithSigners(createTransactionTx);
  await sendAndConfirm(signedCreateTransactionTx, { commitment: 'confirmed' });
  console.log(`Transaction account created. Signature: ${getSignatureFromTransaction(signedCreateTransactionTx)}`);


  // --- Create Proposal ---
  console.log('\n--- Creating proposal account ---');

  // 7. Derive the PDA for the Proposal account
  const [proposalPda] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
        new Uint8Array(Buffer.from('smart_account')),
        bs58.decode(smartAccountSettings),
        new Uint8Array(Buffer.from('transaction')),
        new Uint8Array(new BigUint64Array([transactionIndex]).buffer),
        new Uint8Array(Buffer.from('proposal')),
    ]
  });
  console.log(`Proposal PDA: ${proposalPda}`);

  // 8. Create the instruction to create the proposal account
  const createProposalInstruction = getCreateProposalInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    creator: feePayer,
    rentPayer: feePayer,
    systemProgram: address('11111111111111111111111111111111'),
    transactionIndex: transactionIndex,
    draft: false,
  });

  // 9. Build, sign, and send the proposal creation transaction
  const { value: latestBlockhashForProposal } = await rpc.getLatestBlockhash().send();
  const createProposalTx = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhashForProposal, tx),
    tx => appendTransactionMessageInstructions([createProposalInstruction], tx)
  );

  const signedCreateProposalTx = await signTransactionMessageWithSigners(createProposalTx);
  
  console.log('Sending proposal creation transaction...');
  await sendAndConfirm(signedCreateProposalTx, { commitment: 'confirmed' });
  const proposalSignature = getSignatureFromTransaction(signedCreateProposalTx);
  console.log('Proposal created successfully! Signature:', proposalSignature);


  // --- Approve Proposal ---
  console.log('\n--- Approving proposal ---');

  // 10. Create the instruction to approve the proposal
  const approveProposalInstruction = getApproveProposalInstruction({
    settings: smartAccountSettings,
    signer: feePayer,
    proposal: proposalPda,
    systemProgram: address('11111111111111111111111111111111'),
    args: { memo: null },
  });

  // 11. Build, sign, and send the approval transaction
  const { value: latestBlockhashForApproval } = await rpc.getLatestBlockhash().send();
  const approveProposalTx = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhashForApproval, tx),
    tx => appendTransactionMessageInstructions([approveProposalInstruction], tx)
  );

  const signedApproveProposalTx = await signTransactionMessageWithSigners(approveProposalTx);

  console.log('Sending approval transaction...');
  await sendAndConfirm(signedApproveProposalTx, { commitment: 'confirmed' });
  const approvalSignature = getSignatureFromTransaction(signedApproveProposalTx);
  console.log('Proposal approved successfully! Signature:', approvalSignature);


  // --- Execute Transaction ---
  console.log('\n--- Executing transaction ---');

  const initialBalance = await rpc.getBalance(feePayer.address).send();
  console.log(`Fee payer balance before execution: ${initialBalance.value} lamports`);

  // 12. Create the instruction to execute the transaction
  const executeTransactionInstruction = getExecuteTransactionInstruction({
    settings: smartAccountSettings,
    proposal: proposalPda,
    transaction: transactionPda,
    signer: feePayer,
  });

  // Manually add the accounts for the inner instruction.
  executeTransactionInstruction.accounts.push(
    { address: smartAccountPda, role: AccountRole.WRITABLE },
    { address: feePayer.address, role: AccountRole.WRITABLE },
    { address: address('11111111111111111111111111111111'), role: AccountRole.READONLY },
  );

  // 13. Build, sign, and send the execution transaction
  const { value: latestBlockhashForExecution } = await rpc.getLatestBlockhash().send();
  const executeTransactionTx = pipe(
    createTransactionMessage({ version: 0 }),
    tx => setTransactionMessageFeePayerSigner(feePayer, tx),
    tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhashForExecution, tx),
    tx => appendTransactionMessageInstructions([executeTransactionInstruction], tx)
  );

  const signedExecuteTransactionTx = await signTransactionMessageWithSigners(executeTransactionTx);

  console.log('Sending execution transaction...');
  await sendAndConfirm(signedExecuteTransactionTx, { commitment: 'confirmed' });
  const executionSignature = getSignatureFromTransaction(signedExecuteTransactionTx);
  console.log('Transaction executed successfully! Signature:', executionSignature);

  // 14. Verify the transfer
  const finalBalance = await rpc.getBalance(feePayer.address).send();
  console.log(`Fee payer balance after execution: ${finalBalance.value} lamports`);

  assert(finalBalance.value > initialBalance.value, 'Final balance should be greater than initial balance');
  console.log('\n✅ End-to-end test successful!');
}

main().catch(console.error); 