use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HopR2XWk3m5yZz9vD4qJ7wT1cK8vN3bL9sQ6uF2aP5e");

pub const FEE_DENOMINATOR: u64 = 10_000;
pub const MAX_FEE_BPS: u64 = 100; // 1% absolute ceiling

#[program]
pub mod multihopper {
    use super::*;

    /// Initializes protocol state, fee vault, and revenue-sharing parameters
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        fee_bps: u64,
        platform_fee_share_bps: u64,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, MultiHopperError::FeeBpsExceedsMaximum);
        require!(
            platform_fee_share_bps <= FEE_DENOMINATOR,
            MultiHopperError::InvalidShareSplit
        );

        let config = &mut ctx.accounts.protocol_config;
        config.admin = ctx.accounts.admin.key();
        config.fee_collector = ctx.accounts.fee_collector.key();
        config.fee_bps = fee_bps;
        config.platform_fee_share_bps = platform_fee_share_bps;
        config.total_swaps = 0;
        config.total_volume_usd = 0;
        config.bump = ctx.bumps.protocol_config;

        emit!(ProtocolInitializedEvent {
            admin: config.admin,
            fee_collector: config.fee_collector,
            fee_bps,
            platform_fee_share_bps,
        });

        Ok(())
    }

    /// Update configuration settings (Admin Only)
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_fee_bps: Option<u64>,
        new_platform_fee_share_bps: Option<u64>,
        new_fee_collector: Option<Pubkey>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.protocol_config;

        if let Some(fee) = new_fee_bps {
            require!(fee <= MAX_FEE_BPS, MultiHopperError::FeeBpsExceedsMaximum);
            config.fee_bps = fee;
        }
        if let Some(share) = new_platform_fee_share_bps {
            require!(share <= FEE_DENOMINATOR, MultiHopperError::InvalidShareSplit);
            config.platform_fee_share_bps = share;
        }
        if let Some(collector) = new_fee_collector {
            config.fee_collector = collector;
        }

        emit!(ConfigUpdatedEvent {
            admin: config.admin,
            fee_bps: config.fee_bps,
            platform_fee_share_bps: config.platform_fee_share_bps,
            fee_collector: config.fee_collector,
        });

        Ok(())
    }

    /// Executes an atomic 2-Hop trade with strictly enforced minimum output & revenue share
    pub fn execute_two_hop_route<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteTwoHop<'info>>,
        amount_in: u64,
        minimum_amount_out: u64,
        hop1_min_intermediate: u64,
    ) -> Result<()> {
        require!(amount_in > 0, MultiHopperError::ZeroAmountIn);
        require!(minimum_amount_out > 0, MultiHopperError::ZeroMinimumAmountOut);

        // 1. Initial Balances Check for accurate balance differential math
        let intermediate_initial_balance = ctx.accounts.hop_intermediate_vault.amount;
        let user_destination_initial = ctx.accounts.user_destination_token.amount;

        // 2. Transfer token from user to router hop_in_vault
        let cpi_transfer_in_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_source_token.to_account_info(),
                to: ctx.accounts.hop_in_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_transfer_in_ctx, amount_in)?;

        // 3. Hop 1: Execution against First Pool (Token A -> Token B)
        // Perform CPI to Target DEX Pool (e.g., Orca/Raydium mock or direct program call)
        // Here we simulate the direct deterministic token transfer on the simulated DEX vault
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"router_vault_auth",
            &[ctx.bumps.router_authority],
        ]];

        let cpi_hop1_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.hop_in_vault.to_account_info(),
                to: ctx.accounts.pool_one_source_vault.to_account_info(),
                authority: ctx.accounts.router_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_hop1_ctx, amount_in)?;

        // Pool One transfers swapped intermediate token to router intermediate vault
        let cpi_hop1_out_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_one_destination_vault.to_account_info(),
                to: ctx.accounts.hop_intermediate_vault.to_account_info(),
                authority: ctx.accounts.pool_one_authority.to_account_info(),
            },
            &[],
        );
        token::transfer(cpi_hop1_out_ctx, hop1_min_intermediate)?;

        // Reload intermediate account and assert intermediate slippage limit
        ctx.accounts.hop_intermediate_vault.reload()?;
        let intermediate_received = ctx
            .accounts
            .hop_intermediate_vault
            .amount
            .checked_sub(intermediate_initial_balance)
            .ok_or(MultiHopperError::MathOverflow)?;

        require!(
            intermediate_received >= hop1_min_intermediate,
            MultiHopperError::IntermediateSlippageExceeded
        );

        // 4. Hop 2: Execution against Second Pool (Token B -> Token C)
        let cpi_hop2_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.hop_intermediate_vault.to_account_info(),
                to: ctx.accounts.pool_two_source_vault.to_account_info(),
                authority: ctx.accounts.router_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_hop2_ctx, intermediate_received)?;

        // Pool Two transfers final token to temporary router out vault
        let cpi_hop2_out_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.pool_two_destination_vault.to_account_info(),
                to: ctx.accounts.hop_out_vault.to_account_info(),
                authority: ctx.accounts.pool_two_authority.to_account_info(),
            },
            &[],
        );
        token::transfer(cpi_hop2_out_ctx, minimum_amount_out)?;

        // 5. Fee Calculation & Dynamic Split
        ctx.accounts.hop_out_vault.reload()?;
        let final_gross_out = ctx.accounts.hop_out_vault.amount;
        require!(
            final_gross_out >= minimum_amount_out,
            MultiHopperError::FinalSlippageExceeded
        );

        let fee_bps = ctx.accounts.protocol_config.fee_bps;
        let total_protocol_fee = final_gross_out
            .checked_mul(fee_bps)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_div(FEE_DENOMINATOR)
            .ok_or(MultiHopperError::MathOverflow)?;

        let platform_share = total_protocol_fee
            .checked_mul(ctx.accounts.protocol_config.platform_fee_share_bps)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_div(FEE_DENOMINATOR)
            .ok_or(MultiHopperError::MathOverflow)?;

        let referrer_share = total_protocol_fee
            .checked_sub(platform_share)
            .ok_or(MultiHopperError::MathOverflow)?;

        let user_net_amount = final_gross_out
            .checked_sub(total_protocol_fee)
            .ok_or(MultiHopperError::MathOverflow)?;

        require!(
            user_net_amount >= minimum_amount_out,
            MultiHopperError::SlippageExceededAfterFees
        );

        // 6. Transfer Fees to Platform Vault and Referrer Vault
        if platform_share > 0 {
            let fee_cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.hop_out_vault.to_account_info(),
                    to: ctx.accounts.fee_collector_token.to_account_info(),
                    authority: ctx.accounts.router_authority.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(fee_cpi, platform_share)?;
        }

        if referrer_share > 0 {
            let referrer_cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.hop_out_vault.to_account_info(),
                    to: ctx.accounts.referrer_token.to_account_info(),
                    authority: ctx.accounts.router_authority.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(referrer_cpi, referrer_share)?;
        }

        // 7. Transfer Net Out to User
        let user_out_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.hop_out_vault.to_account_info(),
                to: ctx.accounts.user_destination_token.to_account_info(),
                authority: ctx.accounts.router_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(user_out_cpi, user_net_amount)?;

        // 8. Assert Post-Transfer Invariant
        ctx.accounts.user_destination_token.reload()?;
        let total_user_received = ctx
            .accounts
            .user_destination_token
            .amount
            .checked_sub(user_destination_initial)
            .ok_or(MultiHopperError::MathOverflow)?;

        require!(
            total_user_received >= minimum_amount_out,
            MultiHopperError::FinalSlippageExceeded
        );

        // 9. Update Protocol Global Counters
        let config = &mut ctx.accounts.protocol_config;
        config.total_swaps = config.total_swaps.checked_add(1).unwrap();

        emit!(RouteExecutedEvent {
            user: ctx.accounts.user.key(),
            amount_in,
            amount_out: user_net_amount,
            fee_deducted: total_protocol_fee,
            referrer: ctx.accounts.referrer_token.key(),
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"protocol_config"],
        bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Safe address verified as fee collector
    pub fee_collector: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump,
        has_one = admin @ MultiHopperError::UnauthorizedAdmin
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTwoHop<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"protocol_config"],
        bump = protocol_config.bump
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,

    /// CHECK: PDA signer authority for router vault operations
    #[account(
        seeds = [b"router_vault_auth"],
        bump
    )]
    pub router_authority: AccountInfo<'info>,

    // User Token Accounts
    #[account(
        mut,
        constraint = user_source_token.owner == user.key() @ MultiHopperError::InvalidTokenOwner
    )]
    pub user_source_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_destination_token.owner == user.key() @ MultiHopperError::InvalidTokenOwner
    )]
    pub user_destination_token: Account<'info, TokenAccount>,

    // Protocol Intermediate / Buffer Vaults
    #[account(
        mut,
        seeds = [b"hop_in_vault", user_source_token.mint.as_ref()],
        bump
    )]
    pub hop_in_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"hop_inter_vault", intermediate_mint.key().as_ref()],
        bump
    )]
    pub hop_intermediate_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"hop_out_vault", user_destination_token.mint.as_ref()],
        bump
    )]
    pub hop_out_vault: Account<'info, TokenAccount>,

    pub intermediate_mint: Account<'info, Mint>,

    // Pool 1 Accounts
    /// CHECK: Validated via pool execution logic
    pub pool_one_authority: Signer<'info>,
    #[account(mut)]
    pub pool_one_source_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_one_destination_vault: Account<'info, TokenAccount>,

    // Pool 2 Accounts
    /// CHECK: Validated via pool execution logic
    pub pool_two_authority: Signer<'info>,
    #[account(mut)]
    pub pool_two_source_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub pool_two_destination_vault: Account<'info, TokenAccount>,

    // Fee Recipient Accounts
    #[account(
        mut,
        constraint = fee_collector_token.owner == protocol_config.fee_collector @ MultiHopperError::InvalidFeeCollector
    )]
    pub fee_collector_token: Account<'info, TokenAccount>,

    #[account(mut)]
    pub referrer_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE DEFINITIONS
// -----------------------------------------------------------------------------

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,                  // 32
    pub fee_collector: Pubkey,          // 32
    pub fee_bps: u64,                   // 8
    pub platform_fee_share_bps: u64,    // 8
    pub total_swaps: u64,               // 8
    pub total_volume_usd: u64,          // 8
    pub bump: u8,                       // 1
}

impl ProtocolConfig {
    pub const INIT_SPACE: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolInitializedEvent {
    pub admin: Pubkey,
    pub fee_collector: Pubkey,
    pub fee_bps: u64,
    pub platform_fee_share_bps: u64,
}

#[event]
pub struct ConfigUpdatedEvent {
    pub admin: Pubkey,
    pub fee_bps: u64,
    pub platform_fee_share_bps: u64,
    pub fee_collector: Pubkey,
}

#[event]
pub struct RouteExecutedEvent {
    pub user: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee_deducted: u64,
    pub referrer: Pubkey,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum MultiHopperError {
    #[msg("Fee basis points exceed maximum allowable rate (100 bps).")]
    FeeBpsExceedsMaximum,
    #[msg("Invalid share split bps configuration.")]
    InvalidShareSplit,
    #[msg("Caller is unauthorized to mutate administration parameters.")]
    UnauthorizedAdmin,
    #[msg("Zero input amount specified for multi-hop route.")]
    ZeroAmountIn,
    #[msg("Zero minimum output threshold specified.")]
    ZeroMinimumAmountOut,
    #[msg("Intermediate hop 1 slippage was exceeded.")]
    IntermediateSlippageExceeded,
    #[msg("Final route output slippage was exceeded.")]
    FinalSlippageExceeded,
    #[msg("Final amount out below minimum allowable after fee deduction.")]
    SlippageExceededAfterFees,
    #[msg("Arithmetic overflow or underflow detected.")]
    MathOverflow,
    #[msg("Invalid token account owner specified.")]
    InvalidTokenOwner,
    #[msg("Destination fee collector does not match protocol configuration.")]
    InvalidFeeCollector,
}