use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("MHopRouter111111111111111111111111111111111");

pub const MAX_HOPS: usize = 4;
pub const BASIS_POINTS_DIVISOR: u64 = 10_000;
pub const MAX_FEE_BPS: u64 = 500; // 5% absolute cap

#[program]
pub mod multihopper_router {
    use super::*;

    /// Initializes the global router configuration and revenue treasury.
    pub fn initialize(
        ctx: Context<Initialize>,
        protocol_fee_bps: u64,
        admin_authority: Pubkey,
    ) -> Result<()> {
        require!(
            protocol_fee_bps <= MAX_FEE_BPS,
            MultiHopperError::FeeExceedsLimit
        );
        let config = &mut ctx.accounts.config;
        config.admin = admin_authority;
        config.treasury = ctx.accounts.treasury.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.is_paused = false;
        config.bump = ctx.bumps.config;
        config.total_volume_usd = 0;
        config.total_fees_collected = 0;

        emit!(RouterInitializedEvent {
            admin: admin_authority,
            treasury: ctx.accounts.treasury.key(),
            protocol_fee_bps,
        });

        Ok(())
    }

    /// Registers or updates a partner revenue-share account.
    pub fn register_partner(
        ctx: Context<RegisterPartner>,
        partner_fee_bps: u64,
        partner_wallet: Pubkey,
    ) -> Result<()> {
        require!(
            partner_fee_bps <= MAX_FEE_BPS,
            MultiHopperError::FeeExceedsLimit
        );
        let partner_record = &mut ctx.accounts.partner_record;
        partner_record.partner = partner_wallet;
        partner_record.beneficiary = ctx.accounts.beneficiary.key();
        partner_record.partner_fee_bps = partner_fee_bps;
        partner_record.total_accumulated_fees = 0;
        partner_record.bump = ctx.bumps.partner_record;

        emit!(PartnerRegisteredEvent {
            partner: partner_wallet,
            fee_bps: partner_fee_bps,
        });

        Ok(())
    }

    /// Executes an atomic multi-hop swap across DEX interfaces.
    /// Accounts required by external DEX instructions must be passed in `remaining_accounts`.
    pub fn execute_multi_hop_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteMultiHopSwap<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        hop_payloads: Vec<HopPayload>,
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.is_paused, MultiHopperError::RouterPaused);
        require!(!hop_payloads.is_empty(), MultiHopperError::ZeroHopsProvided);
        require!(
            hop_payloads.len() <= MAX_HOPS,
            MultiHopperError::MaxHopsExceeded
        );
        require!(amount_in > 0, MultiHopperError::ZeroAmountIn);

        // 1. Calculate dynamic protocol and partner fee splits
        let protocol_fee = amount_in
            .checked_mul(config.protocol_fee_bps)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_div(BASIS_POINTS_DIVISOR)
            .ok_or(MultiHopperError::MathOverflow)?;

        let mut partner_fee = 0u64;
        if let Some(partner_record) = &mut ctx.accounts.partner_record {
            partner_fee = amount_in
                .checked_mul(partner_record.partner_fee_bps)
                .ok_or(MultiHopperError::MathOverflow)?
                .checked_div(BASIS_POINTS_DIVISOR)
                .ok_or(MultiHopperError::MathOverflow)?;

            partner_record.total_accumulated_fees = partner_record
                .total_accumulated_fees
                .checked_add(partner_fee)
                .ok_or(MultiHopperError::MathOverflow)?;
        }

        let total_deduction = protocol_fee
            .checked_add(partner_fee)
            .ok_or(MultiHopperError::MathOverflow)?;
        let net_amount_in = amount_in
            .checked_sub(total_deduction)
            .ok_or(MultiHopperError::MathOverflow)?;

        // 2. Transfer Protocol Fee
        if protocol_fee > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.user_source_token.to_account_info(),
                to: ctx.accounts.treasury_token_account.to_account_info(),
                authority: ctx.accounts.user_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            token::transfer(CpiContext::new(cpi_program, cpi_accounts), protocol_fee)?;
        }

        // 3. Transfer Partner Fee if applicable
        if partner_fee > 0 {
            let partner_token_dest = ctx
                .accounts
                .partner_token_account
                .as_ref()
                .ok_or(MultiHopperError::MissingPartnerTokenAccount)?;
            let cpi_accounts = Transfer {
                from: ctx.accounts.user_source_token.to_account_info(),
                to: partner_token_dest.to_account_info(),
                authority: ctx.accounts.user_authority.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            token::transfer(CpiContext::new(cpi_program, cpi_accounts), partner_fee)?;
        }

        // 4. Transfer net initial amount to intermediate router vault
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_source_token.to_account_info(),
            to: ctx.accounts.vault_source_token.to_account_info(),
            authority: ctx.accounts.user_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), net_amount_in)?;

        // 5. Query user destination initial balance for invariant verification
        let initial_dest_balance = ctx.accounts.user_destination_token.amount;

        // 6. Execute atomic DEX hops via CPI dispatch using intermediate signer PDA
        let config_bump = config.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"router_config", &[config_bump]]];

        let mut current_account_cursor = 0usize;
        for (i, hop) in hop_payloads.iter().enumerate() {
            let target_program = &ctx.remaining_accounts
                .get(current_account_cursor)
                .ok_or(MultiHopperError::InvalidRemainingAccounts)?;
            
            require_keys_eq!(
                target_program.key(),
                hop.dex_program_id,
                MultiHopperError::ProgramMismatch
            );

            let account_count = hop.account_count as usize;
            let start_idx = current_account_cursor + 1;
            let end_idx = start_idx + account_count;

            require!(
                ctx.remaining_accounts.len() >= end_idx,
                MultiHopperError::RemainingAccountsOutOfBounds
            );

            let hop_account_metas: Vec<AccountMeta> = ctx.remaining_accounts[start_idx..end_idx]
                .iter()
                .map(|acc| {
                    if acc.key == ctx.accounts.vault_authority.key {
                        AccountMeta::new(acc.key(), true)
                    } else if acc.is_writable {
                        AccountMeta::new(acc.key(), acc.is_signer)
                    } else {
                        AccountMeta::new_readonly(acc.key(), acc.is_signer)
                    }
                })
                .collect();

            let mut hop_account_infos: Vec<AccountInfo<'info>> = Vec::with_capacity(account_count + 1);
            hop_account_infos.push(target_program.to_account_info());
            for acc in &ctx.remaining_accounts[start_idx..end_idx] {
                hop_account_infos.push(acc.clone());
            }

            let instruction = Instruction {
                program_id: hop.dex_program_id,
                accounts: hop_account_metas,
                data: hop.instruction_data.clone(),
            };

            invoke_signed(&instruction, &hop_account_infos, signer_seeds)
                .map_err(|_| MultiHopperError::SwapHopFailed)?;

            current_account_cursor = end_idx;

            emit!(HopExecutedEvent {
                hop_index: i as u8,
                dex_program_id: hop.dex_program_id,
            });
        }

        // 7. Reload and verify post-balance invariant (Slippage Check)
        ctx.accounts.user_destination_token.reload()?;
        let final_dest_balance = ctx.accounts.user_destination_token.amount;
        let amount_received = final_dest_balance
            .checked_sub(initial_dest_balance)
            .ok_or(MultiHopperError::MathOverflow)?;

        require!(
            amount_received >= min_amount_out,
            MultiHopperError::SlippageExceeded
        );

        emit!(MultiHopCompletedEvent {
            user: ctx.accounts.user_authority.key(),
            input_amount: amount_in,
            output_amount: amount_received,
            total_fee: total_deduction,
        });

        Ok(())
    }

    /// Admin emergency control to pause or resume routing
    pub fn set_emergency_pause(ctx: Context<EmergencyControl>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = paused;
        emit!(EmergencyPauseEvent { is_paused: paused });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account Contexts
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize<'info>(ctx: Context<Initialize>) -> Result<()> {
    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + RouterConfig::LEN,
        seeds = [b"router_config"],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// CHECK: Protocol Treasury address validated by admin configuration
    pub treasury: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(partner_fee_bps: u64, partner_wallet: Pubkey)]
pub struct RegisterPartner<'info> {
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + PartnerRecord::LEN,
        seeds = [b"partner_share", partner_wallet.as_ref()],
        bump
    )]
    pub partner_record: Account<'info, PartnerRecord>,

    /// CHECK: Beneficiary payout account
    pub beneficiary: UncheckedAccount<'info>,

    #[account(
        constraint = config.admin == admin.key() @ MultiHopperError::Unauthorized
    )]
    pub config: Account<'info, RouterConfig>,

    pub admin: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteMultiHopSwap<'info> {
    #[account(
        seeds = [b"router_config"],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// CHECK: PDA signer for intermediate token management
    #[account(
        seeds = [b"router_config"],
        bump = config.bump
    )]
    pub vault_authority: AccountInfo<'info>,

    #[account(mut)]
    pub user_authority: Signer<'info>,

    #[account(
        mut,
        constraint = user_source_token.owner == user_authority.key() @ MultiHopperError::InvalidTokenOwner
    )]
    pub user_source_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_destination_token.owner == user_authority.key() @ MultiHopperError::InvalidTokenOwner
    )]
    pub user_destination_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = vault_source_token.owner == vault_authority.key() @ MultiHopperError::InvalidVaultOwner
    )]
    pub vault_source_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.owner == config.treasury @ MultiHopperError::InvalidTreasuryOwner
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"partner_share", partner_record.partner.as_ref()],
        bump = partner_record.bump
    )]
    pub partner_record: Option<Account<'info, PartnerRecord>>,

    #[account(mut)]
    pub partner_token_account: Option<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct EmergencyControl<'info> {
    #[account(
        mut,
        seeds = [b"router_config"],
        bump = config.bump,
        has_one = admin @ MultiHopperError::Unauthorized
    )]
    pub config: Account<'info, RouterConfig>,
    pub admin: Signer<'info>,
}

// ---------------------------------------------------------------------------
// Structs & Errors
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct HopPayload {
    pub dex_program_id: Pubkey,
    pub account_count: u8,
    pub instruction_data: Vec<u8>,
}

#[account]
pub struct RouterConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u64,
    pub is_paused: bool,
    pub bump: u8,
    pub total_volume_usd: u128,
    pub total_fees_collected: u128,
}

impl RouterConfig {
    pub const LEN: usize = 32 + 32 + 8 + 1 + 1 + 16 + 16;
}

#[account]
pub struct PartnerRecord {
    pub partner: Pubkey,
    pub beneficiary: Pubkey,
    pub partner_fee_bps: u64,
    pub total_accumulated_fees: u64,
    pub bump: u8,
}

impl PartnerRecord {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 1;
}

#[event]
pub struct RouterInitializedEvent {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u64,
}

#[event]
pub struct PartnerRegisteredEvent {
    pub partner: Pubkey,
    pub fee_bps: u64,
}

#[event]
pub struct HopExecutedEvent {
    pub hop_index: u8,
    pub dex_program_id: Pubkey,
}

#[event]
pub struct MultiHopCompletedEvent {
    pub user: Pubkey,
    pub input_amount: u64,
    pub output_amount: u64,
    pub total_fee: u64,
}

#[event]
pub struct EmergencyPauseEvent {
    pub is_paused: bool,
}

#[error_code]
pub enum MultiHopperError {
    #[msg("Administrative authorization check failed")]
    Unauthorized,
    #[msg("Protocol fee exceeds maximum allowed basis points")]
    FeeExceedsLimit,
    #[msg("The MultiHopper routing engine is currently paused by admin")]
    RouterPaused,
    #[msg("Multi-hop route must include at least one hop")]
    ZeroHopsProvided,
    #[msg("Multi-hop route exceeds system threshold of 4 hops")]
    MaxHopsExceeded,
    #[msg("Input token amount must be strictly greater than zero")]
    ZeroAmountIn,
    #[msg("Arithmetic overflow or underflow detected")]
    MathOverflow,
    #[msg("Destination token balance fell below guaranteed slippage threshold")]
    SlippageExceeded,
    #[msg("Target program key does not match instruction metadata")]
    ProgramMismatch,
    #[msg("Remaining accounts cursor is out of bounds for hop definition")]
    RemainingAccountsOutOfBounds,
    #[msg("Remaining accounts list is malformed or missing target DEX")]
    InvalidRemainingAccounts,
    #[msg("Direct CPI invocation to liquidity venue failed during hop")]
    SwapHopFailed,
    #[msg("Token account owner validation check failed")]
    InvalidTokenOwner,
    #[msg("Vault token account owner validation check failed")]
    InvalidVaultOwner,
    #[msg("Treasury destination token account owner validation check failed")]
    InvalidTreasuryOwner,
    #[msg("Partner account supplied without valid destination token account")]
    MissingPartnerTokenAccount,
}