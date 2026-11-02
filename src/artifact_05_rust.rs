use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("HopR7s8TzE3zW1nZq1uM9P4a5S6d7F8g9H0j1K2L3M4");

pub const MAX_HOPS: usize = 4;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_PROTOCOL_FEE_BPS: u64 = 500; // Max 5%
pub const SEED_CONFIG: &[u8] = b"router_config";
pub const SEED_VAULT_AUTHORITY: &[u8] = b"vault_authority";

#[program]
pub mod multihopper_router {
    use super::*;

    /// Initialize the global MultiHopper configuration and treasury parameters.
    pub fn initialize(
        ctx: Context<Initialize>,
        protocol_fee_bps: u64,
        revshare_enabled: bool,
    ) -> Result<()> {
        require!(
            protocol_fee_bps <= MAX_PROTOCOL_FEE_BPS,
            RouterError::FeeExceedsMaximum
        );

        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.revshare_enabled = revshare_enabled;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault_authority;
        config.total_volume_processed = 0;
        config.total_fees_collected = 0;

        emit!(ConfigInitializedEvent {
            admin: config.admin,
            treasury: config.treasury,
            protocol_fee_bps,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Update configuration parameters (Admin only).
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_treasury: Option<Pubkey>,
        new_fee_bps: Option<u64>,
        new_revshare_enabled: Option<bool>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        if let Some(treasury) = new_treasury {
            config.treasury = treasury;
        }

        if let Some(fee_bps) = new_fee_bps {
            require!(fee_bps <= MAX_PROTOCOL_FEE_BPS, RouterError::FeeExceedsMaximum);
            config.protocol_fee_bps = fee_bps;
        }

        if let Some(enabled) = new_revshare_enabled {
            config.revshare_enabled = enabled;
        }

        emit!(ConfigUpdatedEvent {
            treasury: config.treasury,
            protocol_fee_bps: config.protocol_fee_bps,
            revshare_enabled: config.revshare_enabled,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Execute an atomic multi-hop swap route with slippage and invariant enforcement.
    pub fn execute_route<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ExecuteRoute<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        referral_bps: u64,
        hop_instructions: Vec<HopPayload>,
    ) -> Result<()> {
        require!(amount_in > 0, RouterError::ZeroInputAmount);
        require!(!hop_instructions.is_empty(), RouterError::EmptyRoute);
        require!(
            hop_instructions.len() <= MAX_HOPS,
            RouterError::TooManyHops
        );
        require!(
            referral_bps <= BPS_DENOMINATOR,
            RouterError::InvalidReferralBps
        );

        let initial_user_dest_balance = ctx.accounts.user_destination_token.amount;

        // 1. Transfer initial source tokens from user into the router intermediary vault
        let cpi_transfer_in_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_source_token.to_account_info(),
                to: ctx.accounts.router_intermediate_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        );
        token::transfer(cpi_transfer_in_ctx, amount_in)?;

        // 2. Sequentially execute dynamic hops via direct CPI calls
        let remaining_accounts = ctx.remaining_accounts;
        let mut account_offset: usize = 0;

        for (hop_idx, hop) in hop_instructions.iter().enumerate() {
            require!(
                account_offset + hop.account_count as usize <= remaining_accounts.len(),
                RouterError::InsufficientRemainingAccounts
            );

            let hop_account_infos: Vec<AccountInfo<'info>> = remaining_accounts
                [account_offset..account_offset + hop.account_count as usize]
                .to_vec();

            account_offset += hop.account_count as usize;

            // Generate PDA signing seeds for Vault Authority
            let vault_bump = ctx.accounts.config.vault_bump;
            let signer_seeds: &[&[&[u8]]] = &[&[SEED_VAULT_AUTHORITY, &[vault_bump]]];

            // Resolve target DEX program
            let target_program = &hop_account_infos[0];
            require_keys_eq!(
                *target_program.key,
                hop.target_dex_program,
                RouterError::DexProgramMismatch
            );

            // Construct account metas for target DEX invocation
            let account_metas: Vec<AccountMeta> = hop_account_infos[1..]
                .iter()
                .enumerate()
                .map(|(idx, acc)| {
                    let is_signer = if acc.key == ctx.accounts.vault_authority.key {
                        true
                    } else {
                        hop.signer_flags
                            .get(idx)
                            .copied()
                            .unwrap_or(false)
                    };

                    if hop.writable_flags.get(idx).copied().unwrap_or(false) {
                        AccountMeta::new(*acc.key, is_signer)
                    } else {
                        AccountMeta::new_readonly(*acc.key, is_signer)
                    }
                })
                .collect();

            // Formulate raw instruction
            let ix = solana_program::instruction::Instruction {
                program_id: *target_program.key,
                accounts: account_metas,
                data: hop.instruction_data.clone(),
            };

            // Execute CPI with PDA signer
            solana_program::program::invoke_signed(
                &ix,
                &hop_account_infos,
                signer_seeds,
            ).map_err(|_| RouterError::HopExecutionFailed)?;

            emit!(HopExecutedEvent {
                hop_index: hop_idx as u8,
                dex_program: hop.target_dex_program,
            });
        }

        // 3. Refresh user terminal token balance and assert slippage invariants
        ctx.accounts.user_destination_token.reload()?;
        let final_user_dest_balance = ctx.accounts.user_destination_token.amount;
        
        // Router intermediate vault reload to calculate gross acquired tokens
        ctx.accounts.router_intermediate_vault.reload()?;
        let gross_tokens_acquired = ctx.accounts.router_intermediate_vault.amount;

        require!(
            gross_tokens_acquired > 0,
            RouterError::ZeroSwapOutput
        );

        // 4. Calculate Protocol Fees and Referral Revenue Sharing
        let config = &ctx.accounts.config;
        let mut protocol_fee_amount: u64 = 0;
        let mut referral_fee_amount: u64 = 0;

        if config.protocol_fee_bps > 0 {
            let total_fee_amount = (gross_tokens_acquired as u128)
                .checked_mul(config.protocol_fee_bps as u128)
                .unwrap()
                .checked_div(BPS_DENOMINATOR as u128)
                .unwrap() as u64;

            if config.revshare_enabled && referral_bps > 0 && ctx.accounts.referral_token_account.is_some() {
                referral_fee_amount = (total_fee_amount as u128)
                    .checked_mul(referral_bps as u128)
                    .unwrap()
                    .checked_div(BPS_DENOMINATOR as u128)
                    .unwrap() as u64;
                protocol_fee_amount = total_fee_amount.saturating_sub(referral_fee_amount);
            } else {
                protocol_fee_amount = total_fee_amount;
            }
        }

        let net_user_amount = gross_tokens_acquired
            .saturating_sub(protocol_fee_amount)
            .saturating_sub(referral_fee_amount);

        // Invariant: net user amount must satisfy slippage threshold
        require!(
            net_user_amount >= min_amount_out,
            RouterError::SlippageExceeded
        );

        let vault_bump = config.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[SEED_VAULT_AUTHORITY, &[vault_bump]]];

        // 5. Transfer Net Output tokens to User
        let cpi_transfer_user_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.router_intermediate_vault.to_account_info(),
                to: ctx.accounts.user_destination_token.to_account_info(),
                authority: ctx.accounts.vault_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi_transfer_user_ctx, net_user_amount)?;

        // 6. Transfer Protocol Fee to Treasury Vault
        if protocol_fee_amount > 0 {
            let cpi_fee_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.router_intermediate_vault.to_account_info(),
                    to: ctx.accounts.treasury_token_account.to_account_info(),
                    authority: ctx.accounts.vault_authority.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(cpi_fee_ctx, protocol_fee_amount)?;
        }

        // 7. Transfer Referral Fee if applicable
        if referral_fee_amount > 0 {
            if let Some(ref ref_ata) = ctx.accounts.referral_token_account {
                let cpi_ref_ctx = CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.router_intermediate_vault.to_account_info(),
                        to: ref_ata.to_account_info(),
                        authority: ctx.accounts.vault_authority.to_account_info(),
                    },
                    signer_seeds,
                );
                token::transfer(cpi_ref_ctx, referral_fee_amount)?;
            }
        }

        // 8. Update Metrics
        let config_mut = &mut ctx.accounts.config;
        config_mut.total_volume_processed = config_mut
            .total_volume_processed
            .checked_add(amount_in)
            .unwrap_or(u64::MAX);
        config_mut.total_fees_collected = config_mut
            .total_fees_collected
            .checked_add(protocol_fee_amount + referral_fee_amount)
            .unwrap_or(u64::MAX);

        emit!(RouteCompletedEvent {
            user: ctx.accounts.user.key(),
            amount_in,
            net_amount_out: net_user_amount,
            protocol_fee: protocol_fee_amount,
            referral_fee: referral_fee_amount,
            hops_count: hop_instructions.len() as u8,
        });

        Ok(())
    }
}

// ----------------------------------------------------------------------------
// DATA STRUCTURES & ACCOUNTS
// ----------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct HopPayload {
    pub target_dex_program: Pubkey,
    pub account_count: u8,
    pub writable_flags: Vec<bool>,
    pub signer_flags: Vec<bool>,
    pub instruction_data: Vec<u8>,
}

#[account]
pub struct RouterConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u64,
    pub revshare_enabled: bool,
    pub total_volume_processed: u64,
    pub total_fees_collected: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

impl RouterConfig {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1 + 8 + 8 + 1 + 1 + 64;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Treasury can be any verified multi-sig or cold storage Pubkey
    pub treasury: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        space = RouterConfig::LEN,
        seeds = [SEED_CONFIG],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// CHECK: PDA acting as token authority for intermediary swaps
    #[account(
        seeds = [SEED_VAULT_AUTHORITY],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        has_one = admin @ RouterError::UnauthorizedAdmin
    )]
    pub config: Account<'info, RouterConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteRoute<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [SEED_CONFIG],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// CHECK: PDA that signs token transfers out of the intermediary vault
    #[account(
        seeds = [SEED_VAULT_AUTHORITY],
        bump = config.vault_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    pub source_mint: Account<'info, Mint>,
    pub destination_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_source_token.owner == user.key() @ RouterError::InvalidTokenAccountOwner,
        constraint = user_source_token.mint == source_mint.key() @ RouterError::MintMismatch
    )]
    pub user_source_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_destination_token.owner == user.key() @ RouterError::InvalidTokenAccountOwner,
        constraint = user_destination_token.mint == destination_mint.key() @ RouterError::MintMismatch
    )]
    pub user_destination_token: Account<'info, TokenAccount>,

    /// Program temporary intermediate token vault for atomic multi-hopping
    #[account(
        mut,
        constraint = router_intermediate_vault.owner == vault_authority.key() @ RouterError::InvalidTokenAccountOwner
    )]
    pub router_intermediate_vault: Account<'info, TokenAccount>,

    /// Protocol treasury account receiving the protocol margin
    #[account(
        mut,
        constraint = treasury_token_account.owner == config.treasury @ RouterError::InvalidTreasuryOwner,
        constraint = treasury_token_account.mint == destination_mint.key() @ RouterError::MintMismatch
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    /// Optional affiliate referral account for dynamic revshare splits
    #[account(
        mut,
        constraint = referral_token_account.as_ref().map_or(true, |a| a.mint == destination_mint.key()) @ RouterError::MintMismatch
    )]
    pub referral_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ----------------------------------------------------------------------------
// EVENTS & ERRORS
// ----------------------------------------------------------------------------

#[event]
pub struct ConfigInitializedEvent {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u64,
    pub timestamp: i64,
}

#[event]
pub struct ConfigUpdatedEvent {
    pub treasury: Pubkey,
    pub protocol_fee_bps: u64,
    pub revshare_enabled: bool,
    pub timestamp: i64,
}

#[event]
pub struct HopExecutedEvent {
    pub hop_index: u8,
    pub dex_program: Pubkey,
}

#[event]
pub struct RouteCompletedEvent {
    pub user: Pubkey,
    pub amount_in: u64,
    pub net_amount_out: u64,
    pub protocol_fee: u64,
    pub referral_fee: u64,
    pub hops_count: u8,
}

#[error_code]
pub enum RouterError {
    #[msg("Fee basis points exceed maximum allowed limit of 500 bps (5%).")]
    FeeExceedsMaximum,
    #[msg("Unauthorized: Caller is not the registered router admin.")]
    UnauthorizedAdmin,
    #[msg("Zero input amount provided for multi-hop execution.")]
    ZeroInputAmount,
    #[msg("Empty route provided. At least one hop is required.")]
    EmptyRoute,
    #[msg("Route exceeds the maximum allowed hop depth of 4.")]
    TooManyHops,
    #[msg("Referral basis points exceed 100% (10000 bps).")]
    InvalidReferralBps,
    #[msg("Insufficient remaining accounts supplied for hop CPI execution.")]
    InsufficientRemainingAccounts,
    #[msg("DEX Program ID mismatch between instruction metadata and account info.")]
    DexProgramMismatch,
    #[msg("Intermediate hop CPI swap execution failed.")]
    HopExecutionFailed,
    #[msg("Swap resulted in zero intermediate output.")]
    ZeroSwapOutput,
    #[msg("Slippage limit exceeded: Terminal output falls below min_amount_out.")]
    SlippageExceeded,
    #[msg("Token account owner verification failed.")]
    InvalidTokenAccountOwner,
    #[msg("Treasury owner does not match configured treasury pubkey.")]
    InvalidTreasuryOwner,
    #[msg("Mint mismatch on source, destination, or treasury accounts.")]
    MintMismatch,
}