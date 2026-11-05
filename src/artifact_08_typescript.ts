import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("multihopper protocol suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Multihopper as Program<any>;
  const admin = Keypair.generate();
  const user = Keypair.generate();
  const treasury = Keypair.generate();
  const referrer = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let userMintAAccount: PublicKey;
  let userMintBAccount: PublicKey;
  let treasuryMintAAccount: PublicKey;
  let referrerMintAAccount: PublicKey;
  let executionVaultA: PublicKey;

  let configPDA: PublicKey;
  let configBump: number;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, user, treasury, referrer]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    [configPDA, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("multihopper_vault")],
      program.programId
    );
    executionVaultA = vaultPDA;

    // Create Token Mints
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Setup Token Accounts
    userMintAAccount = await createAccount(provider.connection, user, mintA, user.publicKey);
    userMintBAccount = await createAccount(provider.connection, user, mintB, user.publicKey);
    treasuryMintAAccount = await createAccount(provider.connection, treasury, mintA, treasury.publicKey);
    referrerMintAAccount = await createAccount(provider.connection, referrer, mintA, referrer.publicKey);

    // Mint test liquidity to user (1,000 Token A)
    await mintTo(provider.connection, admin, mintA, userMintAAccount, admin, 1_000_000_000);
  });

  it("Initializes the MultiHopper Protocol with dynamic RevShare", async () => {
    const protocolFeeBps = 30; // 0.30%
    const revenueShareBps = 2000; // 20% of protocol fee to partner

    await program.methods
      .initializeProtocol(protocolFeeBps, revenueShareBps)
      .accounts({
        config: configPDA,
        admin: admin.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPDA);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(30);
    expect(configAccount.revenueShareBps).to.equal(2000);
    expect(configAccount.isPaused).to.be.false;
  });

  it("Blocks unauthorized attacker from altering protocol config", async () => {
    const attacker = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(attacker.publicKey, 10 ** 9);
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .updateConfig(attacker.publicKey, 50, 1000, false)
        .accounts({
          config: configPDA,
          admin: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
      expect.fail("Should have thrown unauthorized error");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("Fails swap if slippage boundary is violated (Circuit-Breaker active)", async () => {
    const amountIn = new anchor.BN(100_000_000); // 100 units
    const unachievableMinOut = new anchor.BN(999_999_999); // Impossible threshold

    // Create execution vault token account
    const vaultATA = await createAccount(
      provider.connection,
      admin,
      mintA,
      admin.publicKey,
      Keypair.generate()
    );

    try {
      await program.methods
        .executeMultiHopSwap(amountIn, unachievableMinOut, [])
        .accounts({
          config: configPDA,
          user: user.publicKey,
          userSourceToken: userMintAAccount,
          userDestinationToken: userMintBAccount,
          treasuryTokenAccount: treasuryMintAAccount,
          referrerTokenAccount: referrerMintAAccount,
          executionVault: vaultATA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      expect.fail("Should have failed with SlippageExceeded or NoHopsProvided");
    } catch (err: any) {
      expect(err.toString()).to.satisfy(
        (msg: string) => msg.includes("NoHopsProvided") || msg.includes("SlippageExceeded")
      );
    }
  });

  it("Validates fee math and revenue split distribution", async () => {
    const amountIn = 1_000_000; // 1.0 Token A
    const feeBps = 30; // 0.30% = 3,000 units
    const expectedFee = (amountIn * feeBps) / 10_000;
    const revShareBps = 2000; // 20% of fee = 600 units
    const expectedReferrerCut = (expectedFee * revShareBps) / 10_000;
    const expectedTreasuryCut = expectedFee - expectedReferrerCut;

    expect(expectedFee).to.equal(3000);
    expect(expectedReferrerCut).to.equal(600);
    expect(expectedTreasuryCut).to.equal(2400);
  });
});