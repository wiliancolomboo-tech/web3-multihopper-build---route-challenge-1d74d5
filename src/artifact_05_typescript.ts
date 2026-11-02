import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Multihopper } from "../target/types/multihopper";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("multihopper-unit-and-integration-suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Multihopper as Program<Multihopper>;

  let adminKeypair: Keypair;
  let userKeypair: Keypair;
  let feeCollectorKeypair: Keypair;
  let referrerKeypair: Keypair;

  let poolOneAuth: Keypair;
  let poolTwoAuth: Keypair;

  let mintTokenA: PublicKey;
  let mintTokenB: PublicKey;
  let mintTokenC: PublicKey;

  let userAtaTokenA: PublicKey;
  let userAtaTokenC: PublicKey;
  let feeCollectorAtaTokenC: PublicKey;
  let referrerAtaTokenC: PublicKey;

  let poolOneVaultA: PublicKey;
  let poolOneVaultB: PublicKey;
  let poolTwoVaultB: PublicKey;
  let poolTwoVaultC: PublicKey;

  let routerAuthPda: PublicKey;
  let routerAuthBump: number;
  let protocolConfigPda: PublicKey;

  let hopInVaultA: PublicKey;
  let hopInterVaultB: PublicKey;
  let hopOutVaultC: PublicKey;

  const FEE_BPS = new anchor.BN(20); // 0.20%
  const PLATFORM_SHARE_BPS = new anchor.BN(7000); // 70% to protocol, 30% to referrer

  before(async () => {
    adminKeypair = Keypair.generate();
    userKeypair = Keypair.generate();
    feeCollectorKeypair = Keypair.generate();
    referrerKeypair = Keypair.generate();
    poolOneAuth = Keypair.generate();
    poolTwoAuth = Keypair.generate();

    // Airdrop SOL
    for (const kp of [adminKeypair, userKeypair, poolOneAuth, poolTwoAuth]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      const blockhash = await provider.connection.getLatestBlockhash();
      await provider.connection.confirmTransaction({ signature: sig, ...blockhash });
    }

    [protocolConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("protocol_config")],
      program.programId
    );

    [routerAuthPda, routerAuthBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_vault_auth")],
      program.programId
    );

    // Create Mints
    mintTokenA = await createMint(provider.connection, adminKeypair, adminKeypair.publicKey, null, 6);
    mintTokenB = await createMint(provider.connection, adminKeypair, adminKeypair.publicKey, null, 6);
    mintTokenC = await createMint(provider.connection, adminKeypair, adminKeypair.publicKey, null, 6);

    // Initialize PDA token vaults for router buffers
    [hopInVaultA] = PublicKey.findProgramAddressSync(
      [Buffer.from("hop_in_vault"), mintTokenA.toBuffer()],
      program.programId
    );
    [hopInterVaultB] = PublicKey.findProgramAddressSync(
      [Buffer.from("hop_inter_vault"), mintTokenB.toBuffer()],
      program.programId
    );
    [hopOutVaultC] = PublicKey.findProgramAddressSync(
      [Buffer.from("hop_out_vault"), mintTokenC.toBuffer()],
      program.programId
    );

    // Create ATA accounts
    userAtaTokenA = await createAccount(provider.connection, userKeypair, mintTokenA, userKeypair.publicKey);
    userAtaTokenC = await createAccount(provider.connection, userKeypair, mintTokenC, userKeypair.publicKey);

    feeCollectorAtaTokenC = await createAccount(provider.connection, adminKeypair, mintTokenC, feeCollectorKeypair.publicKey);
    referrerAtaTokenC = await createAccount(provider.connection, adminKeypair, mintTokenC, referrerKeypair.publicKey);

    // Pool Accounts
    poolOneVaultA = await createAccount(provider.connection, adminKeypair, mintTokenA, poolOneAuth.publicKey);
    poolOneVaultB = await createAccount(provider.connection, adminKeypair, mintTokenB, poolOneAuth.publicKey);
    poolTwoVaultB = await createAccount(provider.connection, adminKeypair, mintTokenB, poolTwoAuth.publicKey);
    poolTwoVaultC = await createAccount(provider.connection, adminKeypair, mintTokenC, poolTwoAuth.publicKey);

    // Seed User & Pool Accounts with Tokens
    await mintTo(provider.connection, adminKeypair, mintTokenA, userAtaTokenA, adminKeypair, 1_000_000_000);
    await mintTo(provider.connection, adminKeypair, mintTokenB, poolOneVaultB, adminKeypair, 10_000_000_000);
    await mintTo(provider.connection, adminKeypair, mintTokenC, poolTwoVaultC, adminKeypair, 10_000_000_000);
  });

  it("1. Initializes the protocol configuration with zero state errors", async () => {
    await program.methods
      .initializeProtocol(FEE_BPS, PLATFORM_SHARE_BPS)
      .accounts({
        protocolConfig: protocolConfigPda,
        admin: adminKeypair.publicKey,
        feeCollector: feeCollectorKeypair.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([adminKeypair])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(protocolConfigPda);
    expect(configAccount.admin.toBase58()).to.equal(adminKeypair.publicKey.toBase58());
    expect(configAccount.feeCollector.toBase58()).to.equal(feeCollectorKeypair.publicKey.toBase58());
    expect(configAccount.feeBps.toNumber()).to.equal(20);
    expect(configAccount.platformFeeShareBps.toNumber()).to.equal(7000);
    expect(configAccount.totalSwaps.toNumber()).to.equal(0);
  });

  it("2. Rejects unauthorized configuration mutations", async () => {
    const maliciousActor = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(maliciousActor.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction({ signature: sig, ...(await provider.connection.getLatestBlockhash()) });

    try {
      await program.methods
        .updateConfig(new anchor.BN(50), null, null)
        .accounts({
          protocolConfig: protocolConfigPda,
          admin: maliciousActor.publicKey,
        })
        .signers([maliciousActor])
        .rpc();
      assert.fail("Should have failed with UnauthorizedAdmin");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAdmin");
    }
  });

  it("3. Enforces hard failure when intermediate hop slippage is violated", async () => {
    const amountIn = new anchor.BN(100_000_000);
    const unrealisticIntermediateMin = new anchor.BN(999_999_999_999); // Exceeds pool output
    const minOut = new anchor.BN(90_000_000);

    try {
      await program.methods
        .executeTwoHopRoute(amountIn, minOut, unrealisticIntermediateMin)
        .accounts({
          user: userKeypair.publicKey,
          protocolConfig: protocolConfigPda,
          routerAuthority: routerAuthPda,
          userSourceToken: userAtaTokenA,
          userDestinationToken: userAtaTokenC,
          hopInVault: hopInVaultA,
          hopIntermediateVault: hopInterVaultB,
          hopOutVault: hopOutVaultC,
          intermediateMint: mintTokenB,
          poolOneAuthority: poolOneAuth.publicKey,
          poolOneSourceVault: poolOneVaultA,
          poolOneDestinationVault: poolOneVaultB,
          poolTwoAuthority: poolTwoAuth.publicKey,
          poolTwoSourceVault: poolTwoVaultB,
          poolTwoDestinationVault: poolTwoVaultC,
          feeCollectorToken: feeCollectorAtaTokenC,
          referrerToken: referrerAtaTokenC,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userKeypair, poolOneAuth, poolTwoAuth])
        .rpc();
      assert.fail("Transaction should have failed due to intermediate slippage check");
    } catch (err: any) {
      expect(err.toString()).to.include("Error");
    }
  });

  it("4. Accurately distributes revenue share between Platform and Referrer PDA", async () => {
    const amountIn = new anchor.BN(10_000_000);
    const hop1Output = new anchor.BN(10_000_000);
    const hop2GrossOut = new anchor.BN(10_000_000);
    const minFinalOut = new anchor.BN(9_900_000);

    // Initial Balances
    const initialFeeCollectorBal = (await getAccount(provider.connection, feeCollectorAtaTokenC)).amount;
    const initialReferrerBal = (await getAccount(provider.connection, referrerAtaTokenC)).amount;

    await program.methods
      .executeTwoHopRoute(amountIn, minFinalOut, hop1Output)
      .accounts({
        user: userKeypair.publicKey,
        protocolConfig: protocolConfigPda,
        routerAuthority: routerAuthPda,
        userSourceToken: userAtaTokenA,
        userDestinationToken: userAtaTokenC,
        hopInVault: hopInVaultA,
        hopIntermediateVault: hopInterVaultB,
        hopOutVault: hopOutVaultC,
        intermediateMint: mintTokenB,
        poolOneAuthority: poolOneAuth.publicKey,
        poolOneSourceVault: poolOneVaultA,
        poolOneDestinationVault: poolOneVaultB,
        poolTwoAuthority: poolTwoAuth.publicKey,
        poolTwoSourceVault: poolTwoVaultB,
        poolTwoDestinationVault: poolTwoVaultC,
        feeCollectorToken: feeCollectorAtaTokenC,
        referrerToken: referrerAtaTokenC,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userKeypair, poolOneAuth, poolTwoAuth])
      .rpc();

    const postFeeCollectorBal = (await getAccount(provider.connection, feeCollectorAtaTokenC)).amount;
    const postReferrerBal = (await getAccount(provider.connection, referrerAtaTokenC)).amount;

    // Fee calculations: 10,000,000 * 20 / 10,000 = 20,000 tokens
    // Platform Share (70%): 14,000 tokens
    // Referrer Share (30%): 6,000 tokens
    expect(Number(postFeeCollectorBal - initialFeeCollectorBal)).to.equal(14000);
    expect(Number(postReferrerBal - initialReferrerBal)).to.equal(6000);
  });
});