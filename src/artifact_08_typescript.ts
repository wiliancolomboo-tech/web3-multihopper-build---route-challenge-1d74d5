import {
  Connection,
  PublicKey,
  Keypair,
  TransactionInstruction,
  AccountMeta,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import { TelemetryService } from "./telemetry";

export interface HopMetadata {
  targetDexProgram: PublicKey;
  writableAccounts: PublicKey[];
  readonlyAccounts: PublicKey[];
  signerAccounts?: PublicKey[];
  instructionData: Buffer;
}

export interface RouteExecutionParams {
  sourceMint: PublicKey;
  destinationMint: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  referralBps: number;
  referralTokenAccount?: PublicKey;
  hops: HopMetadata[];
}

export class MultiHopperClient {
  public program: Program;
  public connection: Connection;
  public wallet: Wallet;
  private telemetry: TelemetryService;

  constructor(
    connection: Connection,
    payerKeypair: Keypair,
    programId: PublicKey,
    idl: any,
    telemetry: TelemetryService
  ) {
    this.connection = connection;
    this.wallet = new Wallet(payerKeypair);
    const provider = new AnchorProvider(connection, this.wallet, {
      preflightCommitment: "processed",
      commitment: "confirmed",
    });
    this.program = new Program(idl, programId, provider);
    this.telemetry = telemetry;
  }

  public static findConfigPda(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("router_config")], programId);
  }

  public static findVaultAuthorityPda(programId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("vault_authority")], programId);
  }

  public async executeMultiHopSwap(params: RouteExecutionParams): Promise<string> {
    const startTime = Date.now();
    const [configPda] = MultiHopperClient.findConfigPda(this.program.programId);
    const [vaultAuthorityPda] = MultiHopperClient.findVaultAuthorityPda(this.program.programId);

    const userSourceAta = await getAssociatedTokenAddress(
      params.sourceMint,
      this.wallet.publicKey
    );
    const userDestAta = await getAssociatedTokenAddress(
      params.destinationMint,
      this.wallet.publicKey
    );

    // Intermediate token holding vault PDA ATA
    const intermediateVaultAta = await getAssociatedTokenAddress(
      params.destinationMint,
      vaultAuthorityPda,
      true
    );

    // Fetch config state for treasury info
    const configState = await (this.program.account as any).routerConfig.fetch(configPda);
    const treasuryDestAta = await getAssociatedTokenAddress(
      params.destinationMint,
      configState.treasury,
      true
    );

    // Pack remaining accounts & hop structures
    const remainingAccounts: AccountMeta[] = [];
    const hopPayloads = [];

    for (const hop of params.hops) {
      // Index 0 of each hop group is the DEX Program ID itself
      const currentHopAccounts: AccountMeta[] = [
        { pubkey: hop.targetDexProgram, isSigner: false, isWritable: false },
      ];

      const writableFlags: boolean[] = [];
      const signerFlags: boolean[] = [];

      for (const pk of hop.writableAccounts) {
        currentHopAccounts.push({ pubkey: pk, isSigner: false, isWritable: true });
        writableFlags.push(true);
        signerFlags.push(false);
      }

      for (const pk of hop.readonlyAccounts) {
        const isSigner = hop.signerAccounts?.some((s) => s.equals(pk)) || false;
        currentHopAccounts.push({ pubkey: pk, isSigner, isWritable: false });
        writableFlags.push(false);
        signerFlags.push(isSigner);
      }

      remainingAccounts.push(...currentHopAccounts);

      hopPayloads.push({
        targetDexProgram: hop.targetDexProgram,
        accountCount: currentHopAccounts.length,
        writableFlags,
        signerFlags,
        instructionData: hop.instructionData,
      });
    }

    const tx = await (this.program.methods as any)
      .executeRoute(
        new BN(params.amountIn.toString()),
        new BN(params.minAmountOut.toString()),
        new BN(params.referralBps.toString()),
        hopPayloads
      )
      .accounts({
        user: this.wallet.publicKey,
        config: configPda,
        vaultAuthority: vaultAuthorityPda,
        sourceMint: params.sourceMint,
        destinationMint: params.destinationMint,
        userSourceToken: userSourceAta,
        userDestinationToken: userDestAta,
        routerIntermediateVault: intermediateVaultAta,
        treasuryTokenAccount: treasuryDestAta,
        referralTokenAccount: params.referralTokenAccount || null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc({ commitment: "confirmed", skipPreflight: false });

    const latencyMs = Date.now() - startTime;

    await this.telemetry.notifyExecutionSuccess({
      signature: tx,
      user: this.wallet.publicKey.toBase58(),
      route: params.hops.map((h) => h.targetDexProgram.toBase58().substring(0, 6) + "..."),
      amountIn: params.amountIn.toString(),
      amountOut: params.minAmountOut.toString(),
      feeCollected: "Dynamic BPS Vault Split",
      latencyMs,
    });

    return tx;
  }
}