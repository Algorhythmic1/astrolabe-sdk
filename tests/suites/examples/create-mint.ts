import {
  createInitializeMint2Instruction,
  getMinimumBalanceForRentExemptMint,
  getMint,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, TransactionMessage } from "@solana/web3.js";
import * as smartAccount from "@sqds/smart-account";
import assert from "assert";
import {
  createAutonomousMultisig,
  createLocalhostConnection,
  generateSmartAccountSigners,
  getNextAccountIndex,
  getTestProgramId,
  TestMembers,
} from "../../utils";

const { Settings } = smartAccount.accounts;

const programId = getTestProgramId();

describe("Examples / Create Mint", () => {
  const connection = createLocalhostConnection();

  let members: TestMembers;
  before(async () => {
    members = await generateSmartAccountSigners(connection);
  });

  it("should create a mint", async () => {
    const accountIndex = await getNextAccountIndex(connection, programId);
    const [settingsPda] = await createAutonomousMultisig({
      connection,
      members,
      threshold: 2,
      timeLock: 0,
      programId,
      accountIndex,
    });

    let multisigAccount = await Settings.fromAccountAddress(
      connection,
      settingsPda
    );

    const transactionIndex =
      smartAccount.utils.toBigInt(multisigAccount.transactionIndex) + 1n;

    const [transactionPda] = smartAccount.getTransactionPda({
      settingsPda,
      transactionIndex: transactionIndex,
      programId,
    });

    // Default vault, index 0.
    const [vaultPda] = smartAccount.getSmartAccountPda({
      settingsPda,
      accountIndex: 0,
      programId,
    });

    const lamportsForMintRent = await getMinimumBalanceForRentExemptMint(
      connection
    );

    // Vault will pay for the Mint account rent, airdrop this amount.
    const airdropSig = await connection.requestAirdrop(
      vaultPda,
      lamportsForMintRent
    );
    await connection.confirmTransaction(airdropSig);

    // Mint account is a signer in the SystemProgram.createAccount ix,
    // so we use an Ephemeral Signer provided by the Multisig program as the Mint account.
    const [mintPda, mintBump] = smartAccount.getEphemeralSignerPda({
      transactionPda,
      ephemeralSignerIndex: 0,
      programId,
    });

    const testTransactionMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: vaultPda,
          newAccountPubkey: mintPda,
          space: MINT_SIZE,
          lamports: lamportsForMintRent,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          mintPda,
          9,
          vaultPda,
          vaultPda,
          TOKEN_2022_PROGRAM_ID
        ),
      ],
    });

    // Create VaultTransaction account.
    let signature = await smartAccount.rpc.createTransaction({
      connection,
      feePayer: members.proposer,
      settingsPda,
      transactionIndex,
      creator: members.proposer.publicKey,
      accountIndex: 0,
      ephemeralSigners: 1,
      transactionMessage: testTransactionMessage,
      memo: "Create new mint",
      programId,
    });
    await connection.confirmTransaction(signature);

    // Create Proposal account.
    signature = await smartAccount.rpc.createProposal({
      connection,
      feePayer: members.voter,
      settingsPda,
      transactionIndex,
      creator: members.voter,
      programId,
    });
    await connection.confirmTransaction(signature);

    // Approve 1.
    signature = await smartAccount.rpc.approveProposal({
      connection,
      feePayer: members.voter,
      settingsPda,
      transactionIndex,
      signer: members.voter,
      memo: "LGTM",
      programId,
    });
    await connection.confirmTransaction(signature);

    // Approve 2.
    signature = await smartAccount.rpc.approveProposal({
      connection,
      feePayer: members.almighty,
      settingsPda,
      transactionIndex,
      signer: members.almighty,
      memo: "LGTM too",
      programId,
    });
    await connection.confirmTransaction(signature);

    // Execute.
    signature = await smartAccount.rpc.executeTransaction({
      connection,
      feePayer: members.executor,
      settingsPda,
      transactionIndex,
      signer: members.executor.publicKey,
      signers: [members.executor],
      sendOptions: { skipPreflight: true },
      programId,
    });
    await connection.confirmTransaction(signature);

    // Assert the Mint account is initialized.
    const mintAccount = await getMint(
      connection,
      mintPda,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.ok(mintAccount.isInitialized);
    assert.strictEqual(
      mintAccount.mintAuthority?.toBase58(),
      vaultPda.toBase58()
    );
    assert.strictEqual(mintAccount.decimals, 9);
    assert.strictEqual(mintAccount.supply, 0n);
  });
});
