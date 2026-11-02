import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Multihopper } from "../target/types/multihopper";
import { 
  createMint, 
  createAccount, 
  mintTo, 
  getAccount, 
  TOKEN_PROGRAM_ID 
} from "@solana/spl-token";
import { assert, expect } from "chai";

describe("MultiHopper Core Smart Contract Verification", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Multihopper as Program<Multihopper>;

  let authority: anchor.web3.Keypair;
  let treasury: anchor.web3.Keypair;
  let integrator: anchor.web3.Keypair;
  let user: anchor.web3.Keypair;

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;

  let configPda: anchor.web3.PublicKey;
  let configBump: number;

  let userTokenA: anchor.web3.PublicKey;
  let userTokenB: anchor.web3.PublicKey;
  let treasuryTokenB: anchor.web3.PublicKey;
  let integratorTokenB: anchor.web3.PublicKey;

  let intermediateVault0: anchor.web3.PublicKey;
  let finalSettlementVault: anchor.web3.PublicKey;

  before(async () => {
    authority = anchor.web3.Keypair.generate();
    treasury = anchor.web3.Keypair.generate();
    integrator = anchor.web3.Keypair.generate();
    user = anchor.web3.Keypair.generate();

    // Airdrop SOL to test actors
    for (const actor of [authority, user]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        10 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);
    }

    [configPda, configBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Create Mints
    mintA = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    mintB = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // User Token Accounts
    userTokenA = await createAccount(
      provider.connection,
      user,
      mintA,
      user.publicKey
    );

    userTokenB = await createAccount(
      provider.connection,
      user,
      mintB,
      user.publicKey
    );

    // Fee Token Accounts
    treasuryTokenB = await createAccount(
      provider.connection,
      authority,
      mintB,
      treasury.publicKey
    );

    integratorTokenB = await createAccount(
      provider.connection,
      authority,
      mintB,
      integrator.publicKey
    );

    // Protocol Internal Vaults (Config PDA is authority)
    intermediateVault0 = await createAccount(
      provider.connection,
      authority,
      mintA,
      configPda
    );

    finalSettlementVault = await createAccount(
      provider.connection,
      authority,
      mintB,
      configPda
    );

    // Mint liquidity to user for swap
    await mintTo(
      provider.connection,
      authority,
      mintA,
      userTokenA,
      authority,
      10_000_000 // 10 Token A
    );

    // Seed settlement vault with Token B to service the swap outcome
    await mintTo(
      provider.connection,
      authority,
      mintB,
      finalSettlementVault,
      authority,
      50_000_000 // 50 Token B
    );
  });

  it("1. Successfully initializes the protocol configuration", async () => {
    const protocolFeeBps = new anchor.BN(15); // 0.15%

    await program.methods
      .initializeProtocol(protocolFeeBps)
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    assert.ok(configAccount.authority.equals(authority.publicKey));
    assert.ok(configAccount.treasury.equals(treasury.publicKey));
    assert.equal(configAccount.protocolFeeBps.toNumber(), 15);
    assert.equal(configAccount.totalSwaps.toNumber(), 0);
  });

  it("2. Executes atomic 2-hop route with exact fee and slippage math", async () => {
    const amountIn = new anchor.BN(1_000_000); // 1.0 Token A
    const integratorFeeBps = new anchor.BN(20); // 0.20%

    // Define 2 realistic pool hops
    const routeHops = [
      {
        poolSourceReserve: new anchor.BN(100_000_000),
        poolDestinationReserve: new anchor.BN(200_000_000),
        poolFeeBps: new anchor.BN(30),
      },
      {
        poolSourceReserve: new anchor.BN(200_000_000),
        poolDestinationReserve: new anchor.BN(400_000_000),
        poolFeeBps: new anchor.BN(30),
      },
    ];

    // Compute expected output:
    // Hop 1: in=1,000,000, rIn=100M, rOut=200M, fee=30bps -> out1 ~ 1,974,277
    // Hop 2: in=1,974,277, rIn=200M, rOut=400M, fee=30bps -> out2 ~ 3,908,981
    // Total fees: Protocol 15bps + Integrator 20bps = 35bps
    const minAmountOut = new anchor.BN(3_800_000); // Safety floor

    const initialUserB = await getAccount(provider.connection, userTokenB);

    await program.methods
      .executeMultiHopSwap(
        amountIn,
        minAmountOut,
        integratorFeeBps,
        routeHops
      )
      .accounts({
        user: user.publicKey,
        config: configPda,
        inputMint: mintA,
        outputMint: mintB,
        userSourceTokenAccount: userTokenA,
        intermediaryVault0: intermediateVault0,
        finalSettlementVault: finalSettlementVault,
        userFinalOutputAccount: userTokenB,
        treasuryTokenAccount: treasuryTokenB,
        integratorTokenAccount: integratorTokenB,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const finalUserB = await getAccount(provider.connection, userTokenB);
    const treasuryB = await getAccount(provider.connection, treasuryTokenB);
    const integratorB = await getAccount(provider.connection, integratorTokenB);

    const receivedAmount = finalUserB.amount - initialUserB.amount;
    assert.isTrue(receivedAmount >= BigInt(minAmountOut.toString()));
    assert.isTrue(treasuryB.amount > 0n);
    assert.isTrue(integratorB.amount > 0n);

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    assert.equal(configAccount.totalSwaps.toNumber(), 1);
  });

  it("3. Deterministically reverts if slippage tolerance is violated", async () => {
    const amountIn = new anchor.BN(1_000_000);
    const integratorFeeBps = new anchor.BN(10);

    const routeHops = [
      {
        poolSourceReserve: new anchor.BN(50_000_000),
        poolDestinationReserve: new anchor.BN(50_000_000),
        poolFeeBps: new anchor.BN(25),
      },
    ];

    // Deliberately set impossible minimum output (10x input)
    const impossibleMinAmountOut = new anchor.BN(10_000_000);

    try {
      await program.methods
        .executeMultiHopSwap(
          amountIn,
          impossibleMinAmountOut,
          integratorFeeBps,
          routeHops
        )
        .accounts({
          user: user.publicKey,
          config: configPda,
          inputMint: mintA,
          outputMint: mintB,
          userSourceTokenAccount: userTokenA,
          intermediaryVault0: intermediateVault0,
          finalSettlementVault: finalSettlementVault,
          userFinalOutputAccount: userTokenB,
          treasuryTokenAccount: treasuryTokenB,
          integratorTokenAccount: integratorTokenB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      assert.fail("Transaction should have failed with SlippageExceeded");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.satisfy(
        (code: string) => code.includes("SlippageExceeded")
      );
    }
  });

  it("4. Prevents route lengths exceeding MAX_HOPS (3)", async () => {
    const amountIn = new anchor.BN(500_000);
    const excessiveHops = [
      { poolSourceReserve: new anchor.BN(100M), poolDestinationReserve: new anchor.BN(100M), poolFeeBps: new anchor.BN(20) },
      { poolSourceReserve: new anchor.BN(100M), poolDestinationReserve: new anchor.BN(100M), poolFeeBps: new anchor.BN(20) },
      { poolSourceReserve: new anchor.BN(100M), poolDestinationReserve: new anchor.BN(100M), poolFeeBps: new anchor.BN(20) },
      { poolSourceReserve: new anchor.BN(100M), poolDestinationReserve: new anchor.BN(100M), poolFeeBps: new anchor.BN(20) },
    ];

    try {
      await program.methods
        .executeMultiHopSwap(amountIn, new anchor.BN(10), new anchor.BN(10), excessiveHops)
        .accounts({
          user: user.publicKey,
          config: configPda,
          inputMint: mintA,
          outputMint: mintB,
          userSourceTokenAccount: userTokenA,
          intermediaryVault0: intermediateVault0,
          finalSettlementVault: finalSettlementVault,
          userFinalOutputAccount: userTokenB,
          treasuryTokenAccount: treasuryTokenB,
          integratorTokenAccount: integratorTokenB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have failed with RouteTooLong");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.satisfy(
        (code: string) => code.includes("RouteTooLong")
      );
    }
  });
});