import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MultiHopper } from "../target/types/multi_hopper";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("MultiHopper On-Chain Engine QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MultiHopper as Program<MultiHopper>;

  let admin: Keypair;
  let user: Keypair;
  let feeRecipient: Keypair;

  let mintA: PublicKey;
  let mintB: PublicKey;
  let mintC: PublicKey;

  let userTokenA: PublicKey;
  let userTokenC: PublicKey;

  let configPda: PublicKey;
  let configBump: number;
  let vaultA: PublicKey;
  let vaultC: PublicKey;

  before(async () => {
    admin = Keypair.generate();
    user = Keypair.generate();
    feeRecipient = Keypair.generate();

    // Airdrop SOL to test actors
    for (const actor of [admin, user]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy Mints
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintC = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Setup Config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("multi_hopper_config")],
      program.programId
    );

    // Setup Vault PDAs
    [vaultA] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_vault"), mintA.toBuffer()],
      program.programId
    );
    [vaultC] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_vault"), mintC.toBuffer()],
      program.programId
    );

    // Setup User Associated Token Accounts
    userTokenA = await createAccount(provider.connection, user, mintA, user.publicKey);
    userTokenC = await createAccount(provider.connection, user, mintC, user.publicKey);

    // Mint test supply
    await mintTo(provider.connection, admin, mintA, userTokenA, admin, 1_000_000_000); // 1,000 Token A
  });

  it("1. Initializes the MultiHopper Protocol with strict fee cap", async () => {
    const feeBps = 20; // 0.20%

    await program.methods
      .initialize(feeBps)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        feeRecipient: feeRecipient.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.feeRecipient.toBase58()).to.equal(feeRecipient.publicKey.toBase58());
    expect(configAccount.feeBps).to.equal(20);
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Rejects routes exceeding maximum permissible hops (Max: 4)", async () => {
    const excessiveHops = [
      { ammType: { constantProductMock: {} }, poolProgramId: admin.publicKey, expectedOutput: new anchor.BN(100), minOutputForHop: new anchor.BN(90) },
      { ammType: { constantProductMock: {} }, poolProgramId: admin.publicKey, expectedOutput: new anchor.BN(100), minOutputForHop: new anchor.BN(90) },
      { ammType: { constantProductMock: {} }, poolProgramId: admin.publicKey, expectedOutput: new anchor.BN(100), minOutputForHop: new anchor.BN(90) },
      { ammType: { constantProductMock: {} }, poolProgramId: admin.publicKey, expectedOutput: new anchor.BN(100), minOutputForHop: new anchor.BN(90) },
      { ammType: { constantProductMock: {} }, poolProgramId: admin.publicKey, expectedOutput: new anchor.BN(100), minOutputForHop: new anchor.BN(90) },
    ];

    try {
      await program.methods
        .executeRoute(new anchor.BN(1_000_000), new anchor.BN(900_000), excessiveHops)
        .accounts({
          config: configPda,
          user: user.publicKey,
          inputMint: mintA,
          outputMint: mintC,
          userSourceToken: userTokenA,
          userDestinationToken: userTokenC,
          protocolSourceVault: vaultA,
          protocolDestVault: vaultC,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have thrown ExceededMaxHops error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExceededMaxHops");
    }
  });

  it("3. Enforces strict zero-revert atomic slippage rollback", async () => {
    const failingSlippageHops = [
      {
        ammType: { constantProductMock: {} },
        poolProgramId: admin.publicKey,
        expectedOutput: new anchor.BN(800_000),
        minOutputForHop: new anchor.BN(800_000),
      },
    ];

    // Client requests 950_000 min output, but hop only yields 800_000
    try {
      await program.methods
        .executeRoute(new anchor.BN(1_000_000), new anchor.BN(950_000), failingSlippageHops)
        .accounts({
          config: configPda,
          user: user.publicKey,
          inputMint: mintA,
          outputMint: mintC,
          userSourceToken: userTokenA,
          userDestinationToken: userTokenC,
          protocolSourceVault: vaultA,
          protocolDestVault: vaultC,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have rolled back due to SlippageExceeded");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }

    // Verify User Token Balance remained intact (Zero state modification)
    const userBalanceA = await getAccount(provider.connection, userTokenA);
    expect(Number(userBalanceA.amount)).to.equal(1_000_000_000);
  });

  it("4. Validates zero hops rejection", async () => {
    try {
      await program.methods
        .executeRoute(new anchor.BN(100_000), new anchor.BN(90_000), [])
        .accounts({
          config: configPda,
          user: user.publicKey,
          inputMint: mintA,
          outputMint: mintC,
          userSourceToken: userTokenA,
          userDestinationToken: userTokenC,
          protocolSourceVault: vaultA,
          protocolDestVault: vaultC,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      expect.fail("Should have rejected empty route");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroHopsForbidden");
    }
  });
});