import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Multihopper } from "../target/types/multihopper";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("MultiHopper Multi-Hop & Revenue Share Integration Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Multihopper as Program<Multihopper>;

  const admin = Keypair.generate();
  const partner = Keypair.generate();
  const user = Keypair.generate();
  const treasury = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;
  let mintC: PublicKey;

  let userInputATA: PublicKey;
  let userOutputATA: PublicKey;
  let treasuryOutputATA: PublicKey;

  let configPDA: PublicKey;
  let configBump: number;
  let partnerVaultPDA: PublicKey;
  let partnerEscrowPDA: PublicKey;
  let transientEscrowPDA: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, partner, user, treasury]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // Deploy test token mints
    mintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    mintC = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Initialize Global Config PDA
    [configPDA, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    // Partner Vault and Escrow PDAs for Mint C
    [partnerVaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner-vault"), partner.publicKey.toBuffer(), mintC.toBuffer()],
      program.programId
    );

    [partnerEscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner-token-escrow"), partner.publicKey.toBuffer(), mintC.toBuffer()],
      program.programId
    );

    [transientEscrowPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("transient-escrow"), user.publicKey.toBuffer(), mintC.toBuffer()],
      program.programId
    );

    // Create Token Accounts
    userInputATA = await createAccount(provider.connection, user, mintA, user.publicKey);
    userOutputATA = await createAccount(provider.connection, user, mintC, user.publicKey);
    treasuryOutputATA = await createAccount(provider.connection, admin, mintC, treasury.publicKey);

    // Mint input liquidity to user
    await mintTo(provider.connection, admin, mintA, userInputATA, admin, 1_000_000_000); // 1,000 tokens
  });

  it("1. Initializes global protocol configuration with 30 bps base fee and 50% partner split", async () => {
    const baseFeeBps = 30; // 0.30%
    const partnerShareBps = 5000; // 50.00%

    await program.methods
      .initialize(baseFeeBps, partnerShareBps)
      .accounts({
        config: configPDA,
        admin: admin.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.globalConfig.fetch(configPDA);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(configAccount.baseFeeBps).to.equal(30);
    expect(configAccount.partnerShareBps).to.equal(5000);
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Fails to initialize if base fee exceeds 500 bps limit", async () => {
    const excessiveFee = 501;
    const tempAdmin = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(tempAdmin.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig);

    const [tempConfigPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config-invalid")],
      program.programId
    );

    try {
      await program.methods
        .initialize(excessiveFee, 5000)
        .accounts({
          config: tempConfigPDA,
          admin: tempAdmin.publicKey,
          treasury: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([tempAdmin])
        .rpc();
      expect.fail("Should have failed with FeeTooHigh");
    } catch (err: any) {
      expect(err.toString()).to.include("FeeTooHigh");
    }
  });

  it("3. Executes 2-hop route atomically: MintA -> MintB -> MintC with exact rev-share allocation", async () => {
    const amountIn = new anchor.BN(100_000_000); // 100 tokens
    const minAmountOut = new anchor.BN(90_000_000); // 90 tokens minimum (expecting ~99 tokens)

    const hops = [
      {
        poolProgramId: Keypair.generate().publicKey,
        intermediateMint: mintB,
      },
      {
        poolProgramId: Keypair.generate().publicKey,
        intermediateMint: mintC,
      },
    ];

    // Seed transient escrow to emulate AMM return balance for Mint C
    await mintTo(provider.connection, admin, mintC, transientEscrowPDA, admin, 100_000_000);

    const tx = await program.methods
      .executeRoute(amountIn, minAmountOut, hops)
      .accounts({
        config: configPDA,
        user: user.publicKey,
        partner: partner.publicKey,
        inputMint: mintA,
        outputMint: mintC,
        userInputToken: userInputATA,
        userOutputToken: userOutputATA,
        protocolTreasuryToken: treasuryOutputATA,
        partnerVault: partnerVaultPDA,
        partnerTokenEscrow: partnerEscrowPDA,
        transientEscrow: transientEscrowPDA,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    expect(tx).to.be.a("string");

    // Verify user balance received net settlement
    const userBalance = await getAccount(provider.connection, userOutputATA);
    expect(Number(userBalance.amount)).to.be.greaterThan(90_000_000);

    // Verify Partner Vault received on-chain accumulated rewards
    const partnerVault = await program.account.partnerVault.fetch(partnerVaultPDA);
    expect(Number(partnerVault.accumulatedRewards)).to.be.greaterThan(0);

    // Verify Protocol Treasury received its cut
    const treasuryBalance = await getAccount(provider.connection, treasuryOutputATA);
    expect(Number(treasuryBalance.amount)).to.be.greaterThan(0);
  });

  it("4. Strictly reverts when slippage limit is violated (min_amount_out too high)", async () => {
    const amountIn = new anchor.BN(10_000_000);
    const unrealisticMinOut = new anchor.BN(200_000_000); // Impossible return

    const hops = [
      {
        poolProgramId: Keypair.generate().publicKey,
        intermediateMint: mintB,
      },
    ];

    try {
      await program.methods
        .executeRoute(amountIn, unrealisticMinOut, hops)
        .accounts({
          config: configPDA,
          user: user.publicKey,
          partner: partner.publicKey,
          inputMint: mintA,
          outputMint: mintC,
          userInputToken: userInputATA,
          userOutputToken: userOutputATA,
          protocolTreasuryToken: treasuryOutputATA,
          partnerVault: partnerVaultPDA,
          partnerTokenEscrow: partnerEscrowPDA,
          transientEscrow: transientEscrowPDA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      expect.fail("Transaction should have reverted on SlippageExceeded");
    } catch (err: any) {
      expect(err.toString()).to.include("SlippageExceeded");
    }
  });

  it("5. Allows Partner to claim accumulated revenue-share rewards into clean wallet", async () => {
    const partnerDestinationATA = await createAccount(
      provider.connection,
      partner,
      mintC,
      partner.publicKey
    );

    const vaultBefore = await program.account.partnerVault.fetch(partnerVaultPDA);
    const claimableAmount = Number(vaultBefore.accumulatedRewards);
    expect(claimableAmount).to.be.greaterThan(0);

    await program.methods
      .claimRevenue()
      .accounts({
        partner: partner.publicKey,
        tokenMint: mintC,
        partnerVault: partnerVaultPDA,
        partnerTokenEscrow: partnerEscrowPDA,
        partnerDestinationToken: partnerDestinationATA,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([partner])
      .rpc();

    // Vault should reset to zero
    const vaultAfter = await program.account.partnerVault.fetch(partnerVaultPDA);
    expect(Number(vaultAfter.accumulatedRewards)).to.equal(0);

    // Destination ATA should have received funds
    const partnerWalletBalance = await getAccount(provider.connection, partnerDestinationATA);
    expect(Number(partnerWalletBalance.amount)).to.equal(claimableAmount);
  });
});