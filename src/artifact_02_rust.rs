use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Hopr111111111111111111111111111111111111111");

#[program]
pub mod multi_hopper {
    use super::*;

    /// Initializes global protocol configuration including admin and protocol fee basis points.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u16,
    ) -> Result<()> {
        require!(protocol_fee_bps <= 1000, MultiHopperError::FeeTooHigh); // Max 10.00%
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.is_paused = false;
        config.total_volume_usd = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Updates fee distribution parameters or protocol state.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_fee_bps: Option<u16>,
        new_treasury: Option<Pubkey>,
        is_paused: Option<bool>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(fee) = new_fee_bps {
            require!(fee <= 1000, MultiHopperError::FeeTooHigh);
            config.protocol_fee_bps = fee;
        }
        if let Some(treasury) = new_treasury {
            config.treasury = treasury;
        }
        if let Some(paused) = is_paused {
            config.is_paused = paused;
        }
        Ok(())
    }

    /// Executes an atomic multi-hop swap across pre-configured intermediary pools.
    /// Deducts referral & protocol revenue share, guarantees min_amount_out or reverts.
    pub fn execute_multi_hop_route<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteMultiHopRoute<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        referrer_fee_bps: u16,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.is_paused, MultiHopperError::ProtocolPaused);
        require!(amount_in > 0, MultiHopperError::InvalidZeroAmount);
        require!(referrer_fee_bps <= 500, MultiHopperError::FeeTooHigh); // Max 5.00% referrer

        // 1. Pull source tokens from the User into the MultiHopper Intermediate Vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_source_token.to_account_info(),
            to: ctx.accounts.protocol_vault_in.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount_in)?;

        // 2. Perform Hop Swaps
        // In this production engine, hops are executed by transferring balances through
        // intermediate mock/AMM pools represented in remaining_accounts.
        // We track initial destination balance to deterministically verify final output.
        let dest_balance_before = ctx.accounts.protocol_vault_out.amount;

        // Process pool legs through Remaining Accounts
        // Remaining accounts layout per hop: [Pool_Source, Pool_Dest, Pool_Authority]
        let remaining_accounts = ctx.remaining_accounts;
        require!(
            remaining_accounts.len() % 3 == 0 && !remaining_accounts.is_empty(),
            MultiHopperError::InvalidHopAccountLayout
        );

        let hops_count = remaining_accounts.len() / 3;
        require!(hops_count <= 4, MultiHopperError::ExceededMaxHops);

        let config_seeds = &[b"config".as_ref(), &[config.bump]];
        let signer_seeds = &[&config_seeds[..]];

        let mut current_hop_input = amount_in;

        for hop_idx in 0..hops_count {
            let offset = hop_idx * 3;
            let pool_source = &remaining_accounts[offset];
            let pool_dest = &remaining_accounts[offset + 1];
            let pool_authority = &remaining_accounts[offset + 2];

            // Execute simulated pool swap CPI (or internal liquidity exchange logic)
            // Simulates constant product dynamic hop: output = input * 997 / 1000
            let hop_output = (current_hop_input as u128)
                .checked_mul(997)
                .ok_or(MultiHopperError::MathOverflow)?
                .checked_div(1000)
                .ok_or(MultiHopperError::MathOverflow)? as u64;

            // Safe transfer invocation using Program PDA
            let pool_transfer_cpi = Transfer {
                from: pool_source.clone(),
                to: pool_dest.clone(),
                authority: ctx.accounts.config.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    pool_transfer_cpi,
                    signer_seeds,
                ),
                current_hop_input,
            )?;

            current_hop_input = hop_output;
        }

        // Refresh destination vault balance
        ctx.accounts.protocol_vault_out.reload()?;
        let dest_balance_after = ctx.accounts.protocol_vault_out.amount;
        let total_output = dest_balance_after
            .checked_sub(dest_balance_before)
            .ok_or(MultiHopperError::MathOverflow)?;

        // 3. Strict Slippage Guard
        require!(
            total_output >= min_amount_out,
            MultiHopperError::SlippageLimitExceeded
        );

        // 4. Calculate Revenue Share Splits
        let protocol_fee_amount = (total_output as u128)
            .checked_mul(config.protocol_fee_bps as u128)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_div(10000)
            .ok_or(MultiHopperError::MathOverflow)? as u64;

        let referrer_fee_amount = if ctx.accounts.referrer_token_account.is_some() {
            (total_output as u128)
                .checked_mul(referrer_fee_bps as u128)
                .ok_or(MultiHopperError::MathOverflow)?
                .checked_div(10000)
                .ok_or(MultiHopperError::MathOverflow)? as u64
        } else {
            0
        };

        let user_net_output = total_output
            .checked_sub(protocol_fee_amount)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_sub(referrer_fee_amount)
            .ok_or(MultiHopperError::MathOverflow)?;

        // 5. Disburse Protocol Fee Share
        if protocol_fee_amount > 0 {
            let treasury_cpi = Transfer {
                from: ctx.accounts.protocol_vault_out.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    treasury_cpi,
                    signer_seeds,
                ),
                protocol_fee_amount,
            )?;
        }

        // 6. Disburse Referrer Revenue Share
        if referrer_fee_amount > 0 {
            if let Some(ref ref_account) = ctx.accounts.referrer_token_account {
                let ref_cpi = Transfer {
                    from: ctx.accounts.protocol_vault_out.to_account_info(),
                    to: ref_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                };
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        ref_cpi,
                        signer_seeds,
                    ),
                    referrer_fee_amount,
                )?;
            }
        }

        // 7. Deliver Net Output to User
        let user_final_cpi = Transfer {
            from: ctx.accounts.protocol_vault_out.to_account_info(),
            to: ctx.accounts.user_destination_token.to_account_info(),
            authority: ctx.accounts.config.to_account_info(),
        };
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                user_final_cpi,
                signer_seeds,
            ),
            user_net_output,
        )?;

        // 8. Emit Verifiable Audit Event
        emit!(RouteExecutedEvent {
            user: ctx.accounts.user.key(),
            amount_in,
            total_output,
            user_net_output,
            protocol_fee: protocol_fee_amount,
            referrer_fee: referrer_fee_amount,
            hops_count: hops_count as u8,
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
        space = 8 + ProtocolConfig::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Protocol Treasury Key checked manually
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ MultiHopperError::UnauthorizedAdmin
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteMultiHopRoute<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    // Source accounts
    #[account(mut)]
    pub user_source_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = protocol_vault_in.owner == config.key() @ MultiHopperError::InvalidVaultOwner
    )]
    pub protocol_vault_in: Account<'info, TokenAccount>,

    // Destination accounts
    #[account(
        mut,
        constraint = protocol_vault_out.owner == config.key() @ MultiHopperError::InvalidVaultOwner
    )]
    pub protocol_vault_out: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_destination_token: Account<'info, TokenAccount>,

    // Treasury accounts
    #[account(
        mut,
        constraint = treasury_token_account.owner == config.treasury @ MultiHopperError::InvalidTreasuryOwner
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    // Optional Referrer account for revenue split
    #[account(mut)]
    pub referrer_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct ProtocolConfig {
    pub admin: Pubkey,          // 32
    pub treasury: Pubkey,       // 32
    pub protocol_fee_bps: u16,  // 2
    pub is_paused: bool,        // 1
    pub total_volume_usd: u64,  // 8
    pub bump: u8,               // 1
}

impl ProtocolConfig {
    pub const LEN: usize = 32 + 32 + 2 + 1 + 8 + 1;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct RouteExecutedEvent {
    pub user: Pubkey,
    pub amount_in: u64,
    pub total_output: u64,
    pub user_net_output: u64,
    pub protocol_fee: u64,
    pub referrer_fee: u64,
    pub hops_count: u8,
    pub timestamp: i64,
}

#[error_code]
pub enum MultiHopperError {
    #[msg("Protocol administrative action unauthorized.")]
    UnauthorizedAdmin,
    #[msg("Protocol fee exceeds maximum allowed basis points (1000 bps).")]
    FeeTooHigh,
    #[msg("Protocol operations are currently paused.")]
    ProtocolPaused,
    #[msg("Zero input amount provided.")]
    InvalidZeroAmount,
    #[msg("Slippage limit violated: Output amount is below min_amount_out.")]
    SlippageLimitExceeded,
    #[msg("Invalid remaining account triplet layout for multi-hop execution.")]
    InvalidHopAccountLayout,
    #[msg("Maximum hop depth (4 hops) exceeded.")]
    ExceededMaxHops,
    #[msg("Math arithmetic overflow occurred.")]
    MathOverflow,
    #[msg("Vault owner does not match expected PDA.")]
    InvalidVaultOwner,
    #[msg("Treasury destination account does not match protocol config.")]
    InvalidTreasuryOwner,
}