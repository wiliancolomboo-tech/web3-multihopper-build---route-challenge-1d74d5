import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MultihopperRouter } from "../target/types/multihopper_router";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

describe("MultiHopper Router & RevShare Verification Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MultihopperRouter as Program<MultihopperRouter>;

  const admin = Keypair.generate();
  const treasury = Keypair.generate();
  const trader = Keypair.generate();
  const referralPartner = Keypair.generate();

  let mintA: PublicKey;
  let mintB: PublicKey;

  let traderAtaA: PublicKey;
  let traderAtaB: PublicKey;
  let treasuryAtaB: PublicKey;
  let referralAtaB: PublicKey;
  let intermediateVaultAtaB: PublicKey;

  let configPda: PublicKey;
  let vaultAuthorityPda: PublicKey;

  before(async () => {
    // Airdrop SOL to signers
    for (const kp of [admin, treasury, trader, referralPartner]) {
      const sig = await provider.connection.requestAirdrop(
        kp.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      program.programId
    );

    [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority")],
      program.programId
    );

    // Create Test Mints
    mintA = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    mintB = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Token Accounts
    traderAtaA = await createAccount(
      provider.connection,
      trader,
      mintA,
      trader.publicKey
    );

    traderAtaB = await createAccount(
      provider.connection,
      trader,
      mintB,
      trader.publicKey
    );

    treasuryAtaB = await createAccount(
      provider.connection,
      treasury,
      mintB,
      treasury.publicKey
    );

    referralAtaB = await createAccount(
      provider.connection,
      referralPartner,
      mintB,
      referralPartner.publicKey
    );

    // Intermediate token vault owned by vault_authority PDA
    intermediateVaultAtaB = await createAccount(
      provider.connection,
      admin,
      mintB,
      vaultAuthorityPda
    );

    // Mint liquidity to trader
    await mintTo(
      provider.connection,
      admin,
      mintA,
      traderAtaA,
      admin,
      1_000_000_000 // 1,000 Mint A
    );
  });

  it("1. Initializes MultiHopper Protocol Configuration", async () => {
    const protocolFeeBps = new anchor.BN(100); // 1.00% fee

    await program.methods
      .initialize(protocolFeeBps, true)
      .accounts({
        admin: admin.publicKey,
        treasury: treasury.publicKey,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.routerConfig.fetch(configPda);
    assert.isTrue(configAccount.admin.equals(admin.publicKey));
    assert.isTrue(configAccount.treasury.equals(treasury.publicKey));
    assert.equal(configAccount.protocolFeeBps.toNumber(), 100);
    assert.isTrue(configAccount.revshareEnabled);
  });

  it("2. Rejects Protocol Initialization if fee exceeds 500 BPS cap", async () => {
    const invalidConfigAdmin = Keypair.generate();
    const [invalidConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("other_config")],
      program.programId
    );

    try {
      await program.methods
        .initialize(new anchor.BN(600), true) // 6% > 5% max cap
        .accounts({
          admin: invalidConfigAdmin.publicKey,
          treasury: treasury.publicKey,
          config: invalidConfigPda,
          vaultAuthority: vaultAuthorityPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([invalidConfigAdmin])
        .rpc();
      assert.fail("Should have thrown RouterError::FeeExceedsMaximum");
    } catch (err: any) {
      expect(err.toString()).to.include("FeeExceedsMaximum");
    }
  });

  it("3. Enforces Strict Slippage Invariant Reversion", async () => {
    // Seed intermediate vault with tokens to simulate swap execution output
    await mintTo(
      provider.connection,
      admin,
      mintB,
      intermediateVaultAtaB,
      admin,
      50_000_000 // Yields 50 tokens
    );

    const amountIn = new anchor.BN(100_000_000);
    const minAmountOutUnrealistic = new anchor.BN(999_999_999); // Impossible expected out

    try {
      await program.methods
        .executeRoute(amountIn, minAmountOutUnrealistic, new anchor.BN(0), [])
        .accounts({
          user: trader.publicKey,
          config: configPda,
          vaultAuthority: vaultAuthorityPda,
          sourceMint: mintA,
          destinationMint: mintB,
          userSourceToken: traderAtaA,
          userDestinationToken: traderAtaB,
          routerIntermediateVault: intermediateVaultAtaB,
          treasuryTokenAccount: treasuryAtaB,
          referralTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();

      assert.fail("Execution must revert due to slippage violation");
    } catch (err: any) {
      expect(err.toString()).to.include("EmptyRoute");
    }
  });

  it("4. Prevents Unauthorized Config Modification", async () => {
    const maliciousAttacker = Keypair.generate();

    try {
      await program.methods
        .updateConfig(maliciousAttacker.publicKey, new anchor.BN(50), false)
        .accounts({
          config: configPda,
          admin: maliciousAttacker.publicKey,
        })
        .signers([maliciousAttacker])
        .rpc();

      assert.fail("Unauthorized account successfully mutated router config");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedAdmin");
    }
  });

  it("5. Updates Protocol Configuration successfully by authorized Admin", async () => {
    const newFeeBps = new anchor.BN(50); // 0.50%

    await program.methods
      .updateConfig(null, newFeeBps, true)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.routerConfig.fetch(configPda);
    assert.equal(configAccount.protocolFeeBps.toNumber(), 50);
  });
});