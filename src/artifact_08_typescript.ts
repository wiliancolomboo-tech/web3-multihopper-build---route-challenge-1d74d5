import { Command } from 'commander';
import { PublicKey, Keypair } from '@solana/web3.js';
import { MultiHopperClient } from './router-engine';
import * as dotenv from 'dotenv';
import * as fs from 'fs';

dotenv.config();

const program = new Command();

program
  .name('multihopper-cli')
  .description('Production MultiHopper Routing and Execution CLI')
  .version('1.0.0');

program
  .command('route')
  .description('Execute an atomic multi-hop swap across Raydium & Orca')
  .requiredOption('-i, --input-mint <address>', 'Source SPL Mint')
  .requiredOption('-o, --output-mint <address>', 'Destination SPL Mint')
  .requiredOption('-a, --amount <number>', 'Input amount in base units')
  .requiredOption('-m, --min-out <number>', 'Minimum output threshold')
  .option('-p, --partner <address>', 'Partner referral address for rev-share')
  .option('-k, --keypair <path>', 'Path to Solana private keypair', './keypair.json')
  .option('-r, --rpc <url>', 'Solana RPC endpoint', process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com')
  .action(async (options) => {
    try {
      const secret = Uint8Array.from(JSON.parse(fs.readFileSync(options.keypair, 'utf-8')));
      const routerProgramId = new PublicKey(
        process.env.ROUTER_PROGRAM_ID || 'MHopRouter111111111111111111111111111111111'
      );

      const client = new MultiHopperClient(options.rpc, secret, routerProgramId);

      console.log(`----------------------------------------------------`);
      console.log(`MultiHopper Routing Dispatcher Initiated`);
      console.log(`Source: ${options.inputMint} -> Dest: ${options.outputMint}`);
      console.log(`Amount In: ${options.amount} | Min Out: ${options.minOut}`);
      console.log(`----------------------------------------------------`);

      // Mock composite multi-hop step descriptor for Raydium -> Orca Whirlpool path
      const sampleHops = [
        {
          dexProgramId: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
          accounts: [],
          instructionData: Buffer.from([1, 2, 3]),
        },
      ];

      const partnerKey = options.partner ? new PublicKey(options.partner) : null;
      const tx = await client.executeAtomicRoute(
        new PublicKey(options.inputMint),
        new PublicKey(options.outputMint),
        BigInt(options.amount),
        BigInt(options.minOut),
        partnerKey,
        sampleHops
      );

      console.log(`Swap successful! Transaction signature: ${tx}`);
    } catch (e: any) {
      console.error(`Route Execution Aborted:`, e.message);
      process.exit(1);
    }
  });

program.parse(process.argv);