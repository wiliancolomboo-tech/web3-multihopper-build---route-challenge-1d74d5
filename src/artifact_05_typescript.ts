import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MultiHopper } from "../target/types/multi_hopper";
import {
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";

describe("multi_hopper test matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MultiHopper as Program<MultiHopper>;

  let admin: Keypair;
  let trader: Keypair;
  let treasury: Keypair;
  let referrer: Keypair;

  let mintA: PublicKey;
  let mintB: PublicKey;

  let configPda: PublicKey;
  let configBump: number;

  let traderAtaA: PublicKey;
  let traderAtaB: PublicKey;
  let treasuryAtaB: PublicKey;
  let referrerAtaB: PublicKey;

  let protocolVaultIn: PublicKey;
  let protocolVaultOut: PublicKey;

  // Intermediate pool accounts for Hop 1
  let poolSourceA: PublicKey;
  let poolDestB: PublicKey;

  before(async () => {
    admin = Keypair.generate();
    trader = Keypair.generate();
    treasury = Keypair.generate();
    referrer = Keypair.generate();

    // Airdrop SOL to test actors
    for (const actor of [admin, trader]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Create Test Mints (A = Input, B = Output)
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

    // Setup Token Accounts
    traderAtaA = await createAccount(provider.connection, trader, mintA, trader.publicKey);
    traderAtaB = await createAccount(provider.connection, trader, mintB, trader.publicKey);
    treasuryAtaB = await createAccount(provider.connection, admin, mintB, treasury.publicKey);
    referrerAtaB = await createAccount(provider.connection, admin, mintB, referrer.publicKey);

    // Protocol Vault PDAs
    protocolVaultIn = await createAccount(provider.connection, admin, mintA, configPda);
    protocolVaultOut = await createAccount(provider.connection, admin, mintB, configPda);

    // Setup simulated liquidity pool accounts
    poolSourceA = await createAccount(provider.connection, admin, mintA, configPda);
    poolDestB = await createAccount(provider.connection, admin, mintB, configPda);

    // Seed Trader with 1,000 MintA tokens
    await mintTo(provider.connection, admin, mintA, traderAtaA, admin, 1_000_000_000);
    // Seed intermediate PoolDest with MintB tokens so it can fulfill swaps
    await mintTo(provider.connection, admin, mintB, protocolVaultOut, admin, 5_000_000_000);
    await mintTo(provider.connection, admin, mintB, poolDestB, admin, 5_000_000_000);
  });

  it("1. Initializes the protocol with valid parameters", async () => {
    const protocolFeeBps = 30; // 0.30%

    await program.methods
      .initializeProtocol(protocolFeeBps)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
        treasury: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.treasury.toBase58()).to.equal(treasury.publicKey.toBase58());
    expect(configAccount.protocolFeeBps).to.equal(30);
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Rejects unauthorized protocol update attempt", async () => {
    const attacker = Keypair.generate();
    let failed = false;

    try {
      await program.methods
        .updateConfig(50, null, null)
        .accounts({
          config: configPda,
          admin: attacker.publicKey,
        })
        .signers([attacker])
        .rpc();
    } catch (_err) {
      failed = true;
    }
    expect(failed).to.be.true;
  });

  it("3. Executes atomic swap with valid slippage and revenue share", async () => {
    const amountIn = new anchor.BN(100_000_000); // 100 MintA
    const minAmountOut = new anchor.BN(50_000_000); // Minimum acceptable 50 MintB
    const referrerFeeBps = 20; // 0.20%

    const traderAtaBBumpBefore = (await getAccount(provider.connection, traderAtaB)).amount;

    await program.methods
      .executeMultiHopRoute(amountIn, minAmountOut, referrerFeeBps)
      .accounts({
        config: configPda,
        user: trader.publicKey,
        userSourceToken: traderAtaA,
        protocolVaultIn: protocolVaultIn,
        protocolVaultOut: protocolVaultOut,
        userDestinationToken: traderAtaB,
        treasuryTokenAccount: treasuryAtaB,
        referrerTokenAccount: referrerAtaB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: poolSourceA, isWritable: true, isSigner: false },
        { pubkey: poolDestB, isWritable: true, isSigner: false },
        { pubkey: configPda, isWritable: false, isSigner: false },
      ])
      .signers([trader])
      .rpc();

    const traderAtaBAfter = (await getAccount(provider.connection, traderAtaB)).amount;
    const treasuryBalance = (await getAccount(provider.connection, treasuryAtaB)).amount;
    const referrerBalance = (await getAccount(provider.connection, referrerAtaB)).amount;

    expect(Number(traderAtaBAfter)).to.be.greaterThan(Number(traderAtaBBumpBefore));
    expect(Number(treasuryBalance)).to.be.greaterThan(0);
    expect(Number(referrerBalance)).to.be.greaterThan(0);
  });

  it("4. Fails deterministically when slippage tolerance is breached", async () => {
    const amountIn = new anchor.BN(10_000_000); // 10 tokens
    const unrealisticMinOut = new anchor.BN(999_999_999_999); // Unattainable output

    let failed = false;
    try {
      await program.methods
        .executeMultiHopRoute(amountIn, unrealisticMinOut, 0)
        .accounts({
          config: configPda,
          user: trader.publicKey,
          userSourceToken: traderAtaA,
          protocolVaultIn: protocolVaultIn,
          protocolVaultOut: protocolVaultOut,
          userDestinationToken: traderAtaB,
          treasuryTokenAccount: treasuryAtaB,
          referrerTokenAccount: null,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: poolSourceA, isWritable: true, isSigner: false },
          { pubkey: poolDestB, isWritable: true, isSigner: false },
          { pubkey: configPda, isWritable: false, isSigner: false },
        ])
        .signers([trader])
        .rpc();
    } catch (err: any) {
      failed = true;
      expect(err.error.errorCode.code).to.equal("SlippageLimitExceeded");
    }
    expect(failed).to.be.true;
  });
});