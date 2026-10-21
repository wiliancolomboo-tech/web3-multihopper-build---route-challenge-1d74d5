import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { TelemetryService, ExecutionReceipt } from './telemetry';

export const JITO_TIP_ACCOUNTS = [
  new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
  new PublicKey('HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe'),
  new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY'),
  new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49'),
];

export interface HopMetadata {
  dexProgramId: PublicKey;
  accounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  instructionData: Buffer;
}

export class MultiHopperClient {
  private connection: Connection;
  private wallet: Keypair;
  private programId: PublicKey;
  private telemetry: TelemetryService;

  constructor(rpcUrl: string, secretKey: Uint8Array, programId: PublicKey) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.wallet = Keypair.fromSecretKey(secretKey);
    this.programId = programId;
    this.telemetry = new TelemetryService();
  }

  public async executeAtomicRoute(
    sourceMint: PublicKey,
    destMint: PublicKey,
    amountIn: bigint,
    minAmountOut: bigint,
    partnerPubkey: PublicKey | null,
    hops: HopMetadata[],
    jitoTipLamports: bigint = 100_000n // Default 0.0001 SOL tip
  ): Promise<string> {
    const startTime = Date.now();

    const [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('router_config')],
      this.programId
    );

    const userSourceAta = getAssociatedTokenAddressSync(sourceMint, this.wallet.publicKey);
    const userDestAta = getAssociatedTokenAddressSync(destMint, this.wallet.publicKey);
    const vaultSourceAta = getAssociatedTokenAddressSync(sourceMint, routerConfigPda, true);

    // Hardcoded protocol treasury ATA for deployment consistency
    const treasuryPubkey = new PublicKey('Treasury111111111111111111111111111111111111');
    const treasuryTokenAccount = getAssociatedTokenAddressSync(sourceMint, treasuryPubkey, true);

    let partnerRecordPda: PublicKey | null = null;
    let partnerTokenAta: PublicKey | null = null;

    if (partnerPubkey) {
      [partnerRecordPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('partner_share'), partnerPubkey.toBuffer()],
        this.programId
      );
      partnerTokenAta = getAssociatedTokenAddressSync(sourceMint, partnerPubkey);
    }

    // Build serialized HopPayload byte blocks
    const hopPayloadBuffers: Buffer[] = [];
    const flattenedRemainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];

    for (const hop of hops) {
      flattenRemainingAccountsAndEncode(hop, flattenedRemainingAccounts, hopPayloadBuffers);
    }

    // 1. Pack core swap instruction data
    const ixData = encodeMultiHopInstruction(amountIn, minAmountOut, hops);

    const keys = [
      { pubkey: routerConfigPda, isSigner: false, isWritable: false },
      { pubkey: routerConfigPda, isSigner: false, isWritable: false }, // vault_authority
      { pubkey: this.wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userSourceAta, isSigner: false, isWritable: true },
      { pubkey: userDestAta, isSigner: false, isWritable: true },
      { pubkey: vaultSourceAta, isSigner: false, isWritable: true },
      { pubkey: treasuryTokenAccount, isSigner: false, isWritable: true },
      { pubkey: partnerRecordPda ?? this.programId, isSigner: false, isWritable: !!partnerRecordPda },
      { pubkey: partnerTokenAta ?? this.programId, isSigner: false, isWritable: !!partnerTokenAta },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...flattenedRemainingAccounts,
    ];

    const multiHopInstruction = new TransactionInstruction({
      programId: this.programId,
      keys,
      data: ixData,
    });

    // 2. Build Jito Tip Instruction
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: this.wallet.publicKey,
      toPubkey: tipAccount,
      lamports: jitoTipLamports,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
      payerKey: this.wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [multiHopInstruction, tipInstruction],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([this.wallet]);

    // 3. Dispatch to RPC / Jito Pipeline
    console.log(`[MultiHopper] Dispatching atomic bundle via optimized transport...`);
    const rawTx = transaction.serialize();
    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });

    await this.connection.confirmTransaction({
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');

    const duration = Date.now() - startTime;
    console.log(`[MultiHopper] Multi-hop settlement confirmed: ${signature} in ${duration}ms`);

    // 4. Fire Async Telemetry
    const receipt: ExecutionReceipt = {
      signature,
      sender: this.wallet.publicKey.toBase58(),
      inputToken: sourceMint.toBase58(),
      outputToken: destMint.toBase58(),
      amountIn: amountIn.toString(),
      amountOut: minAmountOut.toString(),
      hopsCount: hops.length,
      jitoTipSol: Number(jitoTipLamports) / 1e9,
      executionTimeMs: duration,
    };

    await this.telemetry.dispatchExecutionReceipt(receipt);
    return signature;
  }
}

function flattenRemainingAccountsAndEncode(
  hop: HopMetadata,
  flattenedAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
  buffers: Buffer[]
) {
  // Push DEX Program ID as account entry
  flattenedAccounts.push({
    pubkey: hop.dexProgramId,
    isSigner: false,
    isWritable: false,
  });

  for (const acc of hop.accounts) {
    flattenedAccounts.push(acc);
  }
}

function encodeMultiHopInstruction(
  amountIn: bigint,
  minAmountOut: bigint,
  hops: HopMetadata[]
): Buffer {
  // Anchor 8-byte discriminator for "global:execute_multi_hop_swap"
  // Sourced deterministically from sha256("global:execute_multi_hop_swap")[0..8]
  const discriminator = Buffer.from([229, 219, 14, 182, 19, 237, 241, 142]);

  const amountInBuf = Buffer.alloc(8);
  amountInBuf.writeBigUInt64LE(amountIn);

  const minAmountOutBuf = Buffer.alloc(8);
  minAmountOutBuf.writeBigUInt64LE(minAmountOut);

  // Serialize Vec<HopPayload>
  const vectorLengthBuf = Buffer.alloc(4);
  vectorLengthBuf.writeUInt32LE(hops.length);

  const payloadChunks: Buffer[] = [discriminator, amountInBuf, minAmountOutBuf, vectorLengthBuf];

  for (const hop of hops) {
    const programIdBuf = hop.dexProgramId.toBuffer();
    const countBuf = Buffer.from([hop.accounts.length]);
    const dataLenBuf = Buffer.alloc(4);
    dataLenBuf.writeUInt32LE(hop.instructionData.length);
    payloadChunks.push(programIdBuf, countBuf, dataLenBuf, hop.instructionData);
  }

  return Buffer.concat(payloadChunks);
}