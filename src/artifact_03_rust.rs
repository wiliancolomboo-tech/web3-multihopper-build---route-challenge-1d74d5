use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("MHopR11111111111111111111111111111111111111");

#[program]
pub mod multihopper {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= 100, MultiHopperError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.fee_treasury = ctx.accounts.fee_treasury.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.total_volume_usd = 0;
        config.total_swaps = 0;
        config.bump = ctx.bumps.config;
        
        emit!(ProtocolInitialized {
            admin: config.admin,
            fee_treasury: config.fee_treasury,
            fee_bps: protocol_fee_bps,
        });
        Ok(())
    }

    pub fn execute_multi_hop<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ExecuteMultiHop<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
        hop_instructions: Vec<HopInstruction>,
    ) -> Result<()> {
        require!(amount_in > 0, MultiHopperError::InvalidInputAmount);
        require!(!hop_instructions.is_empty(), MultiHopperError::NoHopsProvided);
        require!(hop_instructions.len() <= 4, MultiHopperError::ExcessiveHops);

        let initial_in_balance = ctx.accounts.user_source_token.amount;
        let initial_out_balance = ctx.accounts.user_destination_token.amount;

        // Pull initial tokens into the program's routing escrow vault
        let transfer_in_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_source_token.to_account_info(),
                to: ctx.accounts.escrow_source_token.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(transfer_in_ctx, amount_in)?;

        let mut current_amount_in = amount_in;
        let remaining_accounts = ctx.remaining_accounts;
        let mut account_offset: usize = 0;

        // Iterate through each hop deterministically
        for (idx, hop) in hop_instructions.iter().enumerate() {
            require!(
                account_offset + (hop.accounts_len as usize) <= remaining_accounts.len(),
                MultiHopperError::MalformedAccountInputs
            );

            let hop_account_slice = &remaining_accounts[account_offset..account_offset + (hop.accounts_len as usize)];
            account_offset += hop.accounts_len as usize;

            let hop_output_amount = execute_single_hop_cpi(
                &ctx.accounts.config,
                hop,
                hop_account_slice,
                current_amount_in,
                &ctx.accounts.token_program,
            )?;

            require!(
                hop_output_amount >= hop.minimum_expected_out,
                MultiHopperError::IntermediateHopSlippageViolated
            );

            current_amount_in = hop_output_amount;

            emit!(HopExecuted {
                hop_index: idx as u8,
                protocol_id: hop.protocol_id,
                amount_in: current_amount_in,
                amount_out: hop_output_amount,
            });
        }

        // Protocol fee computation
        let config = &ctx.accounts.config;
        let fee_amount = if config.protocol_fee_bps > 0 {
            (current_amount_in as u128 * config.protocol_fee_bps as u128 / 10_000) as u64
        } else {
            0
        };

        let user_final_amount = current_amount_in
            .checked_sub(fee_amount)
            .ok_or(MultiHopperError::ArithmeticUnderflow)?;

        require!(
            user_final_amount >= minimum_amount_out,
            MultiHopperError::ExcessiveTerminalSlippage
        );

        // Signer seeds for PDA escrow release
        let seeds = &[
            b"multihopper_config".as_ref(),
            &[config.bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // Transfer fee to treasury if applicable
        if fee_amount > 0 {
            let fee_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_destination_token.to_account_info(),
                    to: ctx.accounts.treasury_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(fee_transfer_ctx, fee_amount)?;
        }

        // Transfer final balance to user
        let user_out_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_destination_token.to_account_info(),
                to: ctx.accounts.user_destination_token.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(user_out_ctx, user_final_amount)?;

        // Reload accounts and perform post-condition invariant asserts
        ctx.accounts.user_source_token.reload()?;
        ctx.accounts.user_destination_token.reload()?;
        
        let actual_in_spent = initial_in_balance.saturating_sub(ctx.accounts.user_source_token.amount);
        let actual_out_gained = ctx.accounts.user_destination_token.amount.saturating_sub(initial_out_balance);

        require!(actual_in_spent <= amount_in, MultiHopperError::InvariantViolatedSourceOverdrawn);
        require!(actual_out_gained >= minimum_amount_out, MultiHopperError::InvariantViolatedDestSlippage);

        let config_mut = &mut ctx.accounts.config;
        config_mut.total_swaps = config_mut.total_swaps.checked_add(1).unwrap();

        emit!(MultiHopCompleted {
            user: ctx.accounts.user.key(),
            amount_in,
            amount_out: user_final_amount,
            fee_collected: fee_amount,
            hops_count: hop_instructions.len() as u8,
        });

        Ok(())
    }
}

// Low-level CPI dispatcher resolving to the targeted AMM
fn execute_single_hop_cpi<'info>(
    _config: &Account<'info, ProtocolConfig>,
    hop: &HopInstruction,
    account_slice: &[AccountInfo<'info>],
    amount_in: u64,
    _token_program: &Program<'info, Token>,
) -> Result<u64> {
    // Protocol IDs:
    // 0 = Raydium CPMM / AMMv4
    // 1 = Orca Whirlpool
    // 2 = Meteora DLMM
    match hop.protocol_id {
        0 => {
            // Raydium CPI call representation
            require!(account_slice.len() >= 3, MultiHopperError::MalformedAccountInputs);
            // In a live integration, invoke Raydium swap instruction:
            // anchor_lang::solana_program::program::invoke(&instruction, account_slice)?;
            // Output derived deterministically from the invariant:
            let simulated_out = (amount_in as u128 * 9970 / 10000) as u64;
            Ok(simulated_out)
        }
        1 => {
            // Orca Whirlpool CPI representation
            require!(account_slice.len() >= 3, MultiHopperError::MalformedAccountInputs);
            let simulated_out = (amount_in as u128 * 9980 / 10000) as u64;
            Ok(simulated_out)
        }
        2 => {
            // Meteora DLMM CPI representation
            require!(account_slice.len() >= 3, MultiHopperError::MalformedAccountInputs);
            let simulated_out = (amount_in as u128 * 9985 / 10000) as u64;
            Ok(simulated_out)
        }
        _ => Err(MultiHopperError::UnsupportedProtocolId.into()),
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct HopInstruction {
    pub protocol_id: u8,
    pub accounts_len: u8,
    pub minimum_expected_out: u64,
}

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,
    pub fee_treasury: Pubkey,
    pub protocol_fee_bps: u16,
    pub total_volume_usd: u64,
    pub total_swaps: u64,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 8 + 8 + 1 + 64;
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = ProtocolConfig::LEN,
        seeds = [b"multihopper_config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Protocol revenue vault destination
    pub fee_treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteMultiHop<'info> {
    #[account(
        mut,
        seeds = [b"multihopper_config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub user_source_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_destination_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = escrow_source_token.owner == config.key() @ MultiHopperError::InvalidEscrowOwner
    )]
    pub escrow_source_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = escrow_destination_token.owner == config.key() @ MultiHopperError::InvalidEscrowOwner
    )]
    pub escrow_destination_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == config.fee_treasury @ MultiHopperError::InvalidTreasuryOwner
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct ProtocolInitialized {
    pub admin: Pubkey,
    pub fee_treasury: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct HopExecuted {
    pub hop_index: u8,
    pub protocol_id: u8,
    pub amount_in: u64,
    pub amount_out: u64,
}

#[event]
pub struct MultiHopCompleted {
    pub user: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee_collected: u64,
    pub hops_count: u8,
}

#[error_code]
pub enum MultiHopperError {
    #[msg("Protocol fee exceeds the maximum ceiling of 100 bps (1%)")]
    FeeTooHigh,
    #[msg("Input amount must be greater than zero")]
    InvalidInputAmount,
    #[msg("Zero hop instructions provided")]
    NoHopsProvided,
    #[msg("Max hop length is capped at 4")]
    ExcessiveHops,
    #[msg("Remaining accounts length does not match hop accounts specification")]
    MalformedAccountInputs,
    #[msg("Intermediate hop slippage violated")]
    IntermediateHopSlippageViolated,
    #[msg("Overall minimum destination slippage breached")]
    ExcessiveTerminalSlippage,
    #[msg("Arithmetic underflow during fee calculation")]
    ArithmeticUnderflow,
    #[msg("Unsupported AMM protocol ID")]
    UnsupportedProtocolId,
    #[msg("Invalid escrow token account owner")]
    InvalidEscrowOwner,
    #[msg("Invalid treasury account owner")]
    InvalidTreasuryOwner,
    #[msg("Invariant Violated: More source tokens debited than specified")]
    InvariantViolatedSourceOverdrawn,
    #[msg("Invariant Violated: Insufficient output tokens received")]
    InvariantViolatedDestSlippage,
}