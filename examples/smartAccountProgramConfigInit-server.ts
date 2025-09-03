import {
  pipe,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairFromBytes,
  createSignerFromKeyPair,
  airdropFactory,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  lamports,
  address,
  getProgramDerivedAddress,
} from '@solana/kit';
import fs from 'fs';
import {
  getInitializeProgramConfigInstruction,
} from '../clients/js/src/generated/instructions';
import {
  ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
} from '../clients/js/src/generated/programs';
import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget';
import {
  getBase64EncodedWireTransaction,
} from '@solana/kit';

async function main() {
  // Set up connection and payer
  const rpc = createSolanaRpc('http://localhost:8899');
  const rpcSubscriptions = createSolanaRpcSubscriptions('ws://localhost:8900');

  // Get bytes from local keypair file (SERVER PATHS)
  const keypairFile = fs.readFileSync('/home/ubuntu/.config/solana/id.json');
  const keypairBytes = new Uint8Array(JSON.parse(keypairFile.toString()));
  const initializerKeypairFile = fs.readFileSync('/home/ubuntu/astrolabe_smart_contract/test-program-config-initializer-keypair.json');
  const initializerKeypairBytes = new Uint8Array(JSON.parse(initializerKeypairFile.toString()));

  // Create authority and initializer signers
  const authorityKeypair = await createKeyPairFromBytes(keypairBytes);
  const authoritySigner = await createSignerFromKeyPair(authorityKeypair);
  const initializerKeypair = await createKeyPairFromBytes(initializerKeypairBytes);
  const initializerSigner = await createSignerFromKeyPair(initializerKeypair);

  console.log('Authority:', authoritySigner.address);
  console.log('Initializer:', initializerSigner.address);

  // Airdrop SOL to authority and initializer
  const airdrop = airdropFactory({rpc: rpc, rpcSubscriptions: rpcSubscriptions});
  await airdrop({
    commitment: 'confirmed',
    recipientAddress: authoritySigner.address, 
    lamports: lamports(10_000_000n)
  }); // 10 SOL
  await airdrop({
    commitment: 'confirmed',
    recipientAddress: initializerSigner.address, 
    lamports: lamports(10_000_000n)
  }); // 10 SOL

  // --- Start Balance Check ---
  const { value: balance } = await rpc.getBalance(initializerSigner.address).send();
  console.log(`Initializer balance: ${balance} lamports`);
  if (balance === 0n) {
    console.error('Initializer has no balance. Airdrop may have failed.');
    return;
  }

  console.log('Astrolabe Smart Account Program Address:', ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS);
  // --- End Balance Check ---

  // Derive program config PDA
  const [programConfigPda] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
      new Uint8Array(Buffer.from('smart_account')),
      new Uint8Array(Buffer.from('program_config')),
    ],
  });
  console.log('Program config PDA:', programConfigPda);

  // Derive treasury PDA
  const [treasuryPda] = await getProgramDerivedAddress({
    programAddress: ASTROLABE_SMART_ACCOUNT_PROGRAM_ADDRESS,
    seeds: [
      new Uint8Array(Buffer.from('smart_account')),
      new Uint8Array(Buffer.from('treasury')),
    ],
  });
  console.log('Treasury PDA:', treasuryPda);

  // Build initialize program config instruction
  const instruction = await getInitializeProgramConfigInstruction({
    programConfig: programConfigPda,
    initializer: initializerSigner,
    systemProgram: address('11111111111111111111111111111111'),
    authority: authoritySigner.address,
    smartAccountCreationFee: lamports(10000000n),
    treasury: treasuryPda,
  });

  // Get latest blockhash
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  // Build and send transaction
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(initializerSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([
      getSetComputeUnitLimitInstruction({ units: 200_000 }),
      getSetComputeUnitPriceInstruction({ microLamports: 1 }),
      instruction
    ], tx)
  );
  const signedTransaction = await signTransactionMessageWithSigners(transactionMessage);
  
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  const signature = await sendAndConfirm(signedTransaction, { commitment: 'confirmed' });
  console.log('Program config initialized! Signature:', signature);
  
}

main().catch(console.error); 