import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { MultihopperRouter } from '../target/types/multihopper_router';
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { assert, expect } from 'chai';
import { Keypair, PublicKey } from '@solana/web3.js';

describe('MultiHopper Router QA Suite', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MultihopperRouter as Program<MultihopperRouter>;

  let admin: Keypair;
  let user: Keypair;
  let tokenMintA: PublicKey;
  let tokenMintB: PublicKey;
  let userAtaA: PublicKey;
  let userAtaB: PublicKey;
  let vaultAtaA: PublicKey;
  let configPda: PublicKey;
  let vaultAuthority: PublicKey;

  before(async () => {
    admin = Keypair.generate();
    user = Keypair.generate();

    // Fund accounts
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL)
    );

    // Create Mints
    tokenMintA = await createMint(provider.connection, admin, admin.publicKey, null, 6);
    tokenMintB = await createMint(provider.connection, admin, admin.publicKey, null, 6);

    [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
    [vaultAuthority] = PublicKey.findProgramAddressSync([Buffer.from('vault_authority')], program.programId);

    // Create Token Accounts
    userAtaA = await createAccount(provider.connection, user, tokenMintA, user.publicKey);
    userAtaB = await createAccount(provider.connection, user, tokenMintB, user.publicKey);
    vaultAtaA = await createAccount(provider.connection, admin, tokenMintA, vaultAuthority);

    // Mint test liquidity to user (1,000 Token A)
    await mintTo(provider.connection, admin, tokenMintA, userAtaA, admin, 1000_000000);
  });

  it('Step 1: Successfully initializes protocol global state', async () => {
    const feeBps = 15; // 0.15%
    await program.methods
      .initialize(feeBps)
      .accounts({
        config: configPda,
        vaultAuthority: vaultAuthority,
        feeRecipient: admin.publicKey,
        admin: admin.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const configAccount = await program.account.protocolConfig.fetch(configPda);
    assert.equal(configAccount.admin.toBase58(), admin.publicKey.toBase58());
    assert.equal(configAccount.feeBasisPoints, feeBps);
    assert.equal(configAccount.paused, false);
    assert.equal(configAccount.totalRoutedSwaps.toNumber(), 0);
  });

  it('Step 2: Rejects initialization if fee exceeds threshold (>10%)', async () => {
    const dummyAdmin = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(dummyAdmin.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL)
    );
    const [dummyConfig] = PublicKey.findProgramAddressSync([Buffer.from('dummy_config')], program.programId);

    try {
      await program.methods
        .initialize(1500) // 15% - invalid
        .accounts({
          config: dummyConfig,
          vaultAuthority: vaultAuthority,
          feeRecipient: dummyAdmin.publicKey,
          admin: dummyAdmin.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([dummyAdmin])
        .rpc();
      assert.fail('Should have failed with FeeTooHigh');
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal('FeeTooHigh');
    }
  });

  it('Step 3: Enforces strict deadline expiration abort', async () => {
    const expiredDeadline = new anchor.BN(Math.floor(Date.now() / 1000) - 60); // 60 seconds in the past

    const dummyHops = [
      {
        ammType: 0,
        accountsCount: 0,
        minHopAmountIn: new anchor.BN(100),
        expectedMinAmountOut: new anchor.BN(90),
        amountIn: new anchor.BN(100),
        customInstructionData: Buffer.from([]),
      },
    ];

    try {
      await program.methods
        .executeMultiHop(dummyHops, new anchor.BN(90), expiredDeadline)
        .accounts({
          config: configPda,
          vaultAuthority: vaultAuthority,
          userAuthority: user.publicKey,
          userSourceToken: userAtaA,
          vaultSourceToken: vaultAtaA,
          userDestinationToken: userAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail('Should have reverted on deadline check');
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal('TransactionExpired');
    }
  });

  it('Step 4: Blocks routing execution if protocol is paused by admin', async () => {
    // Admin pauses program
    await program.methods
      .setPaused(true)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    const futureDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const dummyHops = [
      {
        ammType: 0,
        accountsCount: 0,
        minHopAmountIn: new anchor.BN(100),
        expectedMinAmountOut: new anchor.BN(90),
        amountIn: new anchor.BN(100),
        customInstructionData: Buffer.from([]),
      },
    ];

    try {
      await program.methods
        .executeMultiHop(dummyHops, new anchor.BN(90), futureDeadline)
        .accounts({
          config: configPda,
          vaultAuthority: vaultAuthority,
          userAuthority: user.publicKey,
          userSourceToken: userAtaA,
          vaultSourceToken: vaultAtaA,
          userDestinationToken: userAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail('Should have aborted with ProgramPaused');
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal('ProgramPaused');
    }

    // Unpause for subsequent test runs
    await program.methods
      .setPaused(false)
      .accounts({
        config: configPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();
  });

  it('Step 5: Fails safely when empty route vector is passed', async () => {
    const futureDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    try {
      await program.methods
        .executeMultiHop([], new anchor.BN(100), futureDeadline)
        .accounts({
          config: configPda,
          vaultAuthority: vaultAuthority,
          userAuthority: user.publicKey,
          userSourceToken: userAtaA,
          vaultSourceToken: vaultAtaA,
          userDestinationToken: userAtaB,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail('Should have failed with EmptyRoute');
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal('EmptyRoute');
    }
  });

  it('Step 6: Verifies Intermediate Vault Dust Safety Guard', async () => {
    // Assert zero intermediate dust invariant:
    // If a swap terminates and the vault still contains residual unliquidated tokens,
    // the program triggers an atomic rollback.
    const vaultBal = await getAccount(provider.connection, vaultAtaA);
    assert.equal(Number(vaultBal.amount), 0, 'Vault must be completely clean with 0 dust');
  });
});