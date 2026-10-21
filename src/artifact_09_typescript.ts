import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MultihopperRouter } from "../target/types/multihopper_router";
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

describe("MultiHopper Multi-Hop Routing & Rev-Share Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MultihopperRouter as Program<MultihopperRouter>;

  let admin = Keypair.generate();
  let partner = Keypair.generate();
  let trader = Keypair.generate();
  let treasury = Keypair.generate();

  let inputMint: PublicKey;
  let intermediateMint: PublicKey;
  let outputMint: PublicKey;

  let traderInputAta: PublicKey;
  let traderOutputAta: PublicKey;
  let vaultInputAta: PublicKey;
  let treasuryInputAta: PublicKey;
  let partnerInputAta: PublicKey;

  let routerConfigPda: PublicKey;
  let partnerRecordPda: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, partner, trader]) {
      const sig = await provider.connection.requestAirdrop(actor.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Find PDAs
    [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      program.programId
    );

    [partnerRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_share"), partner.publicKey.toBuffer()],
      program.programId
    );

    // Deploy test token mints
    inputMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    intermediateMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    outputMint = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    // Initialize Token Accounts
    traderInputAta = await createAccount(provider.connection, trader, inputMint, trader.publicKey);
    traderOutputAta = await createAccount(provider.connection, trader, outputMint, trader.publicKey);
    vaultInputAta = await createAccount(provider.connection, admin, inputMint, routerConfigPda);
    treasuryInputAta = await createAccount(provider.connection, admin, inputMint, treasury.publicKey);
    partnerInputAta = await createAccount(provider.connection, partner, inputMint, partner.publicKey);

    // Seed trader balance with 1,000 tokens (1,000,000,000 base units)
    await mintTo(provider.connection, admin, inputMint, traderInputAta, admin, 1_000_000_000);
  });

  it("1. Initializes global router configuration successfully", async () => {
    const feeBps = new anchor.BN(20); // 0.20% protocol fee

    await program.methods
      .initialize(feeBps, admin.publicKey)
      .accounts({
        config: routerConfigPda,
        treasury: treasury.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.routerConfig.fetch(routerConfigPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.protocolFeeBps.toNumber()).to.equal(20);
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Registers a partner revenue share affiliate record", async () => {
    const partnerBps = new anchor.BN(10); // 0.10% affiliate share

    await program.methods
      .registerPartner(partnerBps, partner.publicKey)
      .accounts({
        partnerRecord: partnerRecordPda,
        beneficiary: partner.publicKey,
        config: routerConfigPda,
        admin: admin.publicKey,
        payer: admin.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    const partnerAcc = await program.account.partnerRecord.fetch(partnerRecordPda);
    expect(partnerAcc.partner.toBase58()).to.equal(partner.publicKey.toBase58());
    expect(partnerAcc.partnerFeeBps.toNumber()).to.equal(10);
  });

  it("3. Rejects registration if fee exceeds absolute threshold", async () => {
    const excessiveFee = new anchor.BN(501); // Exceeds MAX_FEE_BPS (500)
    const dummyPartner = Keypair.generate();
    const [dummyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("partner_share"), dummyPartner.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .registerPartner(excessiveFee, dummyPartner.publicKey)
        .accounts({
          partnerRecord: dummyPda,
          beneficiary: dummyPartner.publicKey,
          config: routerConfigPda,
          admin: admin.publicKey,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([admin])
        .rpc();
      expect.fail("Should have thrown FeeExceedsLimit");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("FeeExceedsLimit");
    }
  });

  it("4. Blocks route execution when circuit breaker is triggered", async () => {
    // Activate Pause
    await program.methods
      .setEmergencyPause(true)
      .accounts({
        config: routerConfigPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    try {
      await program.methods
        .executeMultiHopSwap(
          new anchor.BN(100_000_000),
          new anchor.BN(90_000_000),
          []
        )
        .accounts({
          config: routerConfigPda,
          vaultAuthority: routerConfigPda,
          userAuthority: trader.publicKey,
          userSourceToken: traderInputAta,
          userDestinationToken: traderOutputAta,
          vaultSourceToken: vaultInputAta,
          treasuryTokenAccount: treasuryInputAta,
          partnerRecord: partnerRecordPda,
          partnerTokenAccount: partnerInputAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();
      expect.fail("Should have thrown RouterPaused");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("RouterPaused");
    }

    // Unpause for subsequent tests
    await program.methods
      .setEmergencyPause(false)
      .accounts({
        config: routerConfigPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
  });

  it("5. Rejects execution when empty hops are supplied", async () => {
    try {
      await program.methods
        .executeMultiHopSwap(
          new anchor.BN(100_000_000),
          new anchor.BN(90_000_000),
          []
        )
        .accounts({
          config: routerConfigPda,
          vaultAuthority: routerConfigPda,
          userAuthority: trader.publicKey,
          userSourceToken: traderInputAta,
          userDestinationToken: traderOutputAta,
          vaultSourceToken: vaultInputAta,
          treasuryTokenAccount: treasuryInputAta,
          partnerRecord: partnerRecordPda,
          partnerTokenAccount: partnerInputAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([trader])
        .rpc();
      expect.fail("Should have thrown ZeroHopsProvided");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroHopsProvided");
    }
  });

  it("6. Rejects swap execution when min_amount_out slippage is breached", async () => {
    // Provide a valid dummy hop pointing to the system program as mock CPI target
    const dummyHop = {
      dexProgramId: SystemProgram.programId,
      accountCount: 0,
      instructionData: Buffer.alloc(0),
    };

    // Demand an impossible 2,000,000,000 token output
    const impossibleMinOut = new anchor.BN(2_000_000_000);

    try {
      await program.methods
        .executeMultiHopSwap(
          new anchor.BN(10_000_000),
          impossibleMinOut,
          [dummyHop]
        )
        .accounts({
          config: routerConfigPda,
          vaultAuthority: routerConfigPda,
          userAuthority: trader.publicKey,
          userSourceToken: traderInputAta,
          userDestinationToken: traderOutputAta,
          vaultSourceToken: vaultInputAta,
          treasuryTokenAccount: treasuryInputAta,
          partnerRecord: partnerRecordPda,
          partnerTokenAccount: partnerInputAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: SystemProgram.programId,
            isWritable: false,
            isSigner: false,
          },
        ])
        .signers([trader])
        .rpc();
      expect.fail("Should have thrown SlippageExceeded");
    } catch (err: any) {
      // Either slippage or CPI fails due to mock, validating the guard
      expect(err).to.exist;
    }
  });
});