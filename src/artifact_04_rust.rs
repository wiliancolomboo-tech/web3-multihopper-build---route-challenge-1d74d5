use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("MHopR11111111111111111111111111111111111111");

pub const MAX_HOPS: usize = 3;
pub const BASIS_POINTS_DIVISOR: u64 = 10_000;
pub const PROTOCOL_FEE_BPS: u64 = 15; // 0.15% base fee
pub const MAX_FEE_BPS: u64 = 250;      // 2.50% ceiling

#[program]
pub mod multihopper {
    use super::*;

    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        protocol_fee_bps: u64,
    ) -> Result<()> {
        require!(
            protocol_fee_bps <= MAX_FEE_BPS,
            MultiHopperError::FeeExceedsCeiling
        );
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.treasury = ctx.accounts.treasury.key();
        config.protocol_fee_bps = protocol_fee_bps;
        config.total_volume_usd = 0;
        config.total_swaps = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn execute_multi_hop_swap(
        ctx: Context<ExecuteMultiHopSwap>,
        amount_in: u64,
        min_amount_out: u64,
        integrator_fee_bps: u64,
        route_hops: Vec<RouteStep>,
    ) -> Result<()> {
        require!(amount_in > 0, MultiHopperError::ZeroAmountIn);
        require!(!route_hops.is_empty(), MultiHopperError::EmptyRoute);
        require!(route_hops.len() <= MAX_HOPS, MultiHopperError::RouteTooLong);
        require!(
            integrator_fee_bps <= MAX_FEE_BPS,
            MultiHopperError::FeeExceedsCeiling
        );

        let user_initial_out_balance = ctx.accounts.user_final_output_account.amount;

        // Step 1: Deposit tokens from user into protocol router vault for Hop 0
        let cpi_accounts = Transfer {
            from: ctx.accounts.user_source_token_account.to_account_info(),
            to: ctx.accounts.intermediary_vault_0.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount_in)?;

        // Step 2: Sequentially process each hop
        let mut current_input_amount = amount_in;
        let total_hops = route_hops.len();

        for i in 0..total_hops {
            let hop = &route_hops[i];
            
            // Pool swap simulated via deterministic liquidity curve step (Constant-Product model)
            // Real mainnet deployment maps CPI to external AMMs (Raydium, Orca, Whirlpool).
            let output_from_hop = compute_hop_output(
                current_input_amount,
                hop.pool_source_reserve,
                hop.pool_destination_reserve,
                hop.pool_fee_bps,
            )?;

            require!(output_from_hop > 0, MultiHopperError::ZeroHopOutput);
            current_input_amount = output_from_hop;
        }

        let raw_final_output = current_input_amount;

        // Step 3: Enforce Global Slippage Tolerance
        require!(
            raw_final_output >= min_amount_out,
            MultiHopperError::SlippageExceeded
        );

        // Step 4: Calculate protocol and integrator fees
        let config = &ctx.accounts.config;
        let protocol_cut = (raw_final_output as u128)
            .checked_mul(config.protocol_fee_bps as u128)
            .unwrap()
            .checked_div(BASIS_POINTS_DIVISOR as u128)
            .unwrap() as u64;

        let integrator_cut = (raw_final_output as u128)
            .checked_mul(integrator_fee_bps as u128)
            .unwrap()
            .checked_div(BASIS_POINTS_DIVISOR as u128)
            .unwrap() as u64;

        let net_output_to_user = raw_final_output
            .checked_sub(protocol_cut)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_sub(integrator_cut)
            .ok_or(MultiHopperError::MathOverflow)?;

        // Ensure user receives strictly at or above the minimum output requested
        require!(
            net_output_to_user >= min_amount_out,
            MultiHopperError::SlippageExceededAfterFees
        );

        // Step 5: Transfer tokens from settlement intermediate vault to User, Treasury, and Integrator
        let config_seeds = &[b"config".as_ref(), &[config.bump]];
        let signer_seeds = &[&config_seeds[..]];

        // 5a. Protocol Treasury Transfer
        if protocol_cut > 0 {
            let treasury_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.final_settlement_vault.to_account_info(),
                    to: ctx.accounts.treasury_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(treasury_transfer_ctx, protocol_cut)?;
        }

        // 5b. Integrator Fee Transfer
        if integrator_cut > 0 {
            let integrator_transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.final_settlement_vault.to_account_info(),
                    to: ctx.accounts.integrator_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(integrator_transfer_ctx, integrator_cut)?;
        }

        // 5c. Net Final Amount Transfer to User
        let user_final_transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.final_settlement_vault.to_account_info(),
                to: ctx.accounts.user_final_output_account.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(user_final_transfer_ctx, net_output_to_user)?;

        // Update statistics
        let config_mut = &mut ctx.accounts.config;
        config_mut.total_swaps = config_mut.total_swaps.checked_add(1).unwrap();

        emit!(SwapExecuted {
            user: ctx.accounts.user.key(),
            input_mint: ctx.accounts.input_mint.key(),
            output_mint: ctx.accounts.output_mint.key(),
            amount_in,
            amount_out: net_output_to_user,
            protocol_fee: protocol_cut,
            integrator_fee: integrator_cut,
            hops_count: total_hops as u8,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// Math logic: Constant Product AMM Invariant Hop Computation: (x * y = k)
pub fn compute_hop_output(
    amount_in: u64,
    reserve_in: u64,
    reserve_out: u64,
    fee_bps: u64,
) -> Result<u64> {
    require!(reserve_in > 0 && reserve_out > 0, MultiHopperError::InvalidReserves);
    let amount_in_u128 = amount_in as u128;
    let reserve_in_u128 = reserve_in as u128;
    let reserve_out_u128 = reserve_out as u128;

    let fee_factor = (BASIS_POINTS_DIVISOR as u128)
        .checked_sub(fee_bps as u128)
        .ok_or(MultiHopperError::MathOverflow)?;

    let amount_in_with_fee = amount_in_u128
        .checked_mul(fee_factor)
        .ok_or(MultiHopperError::MathOverflow)?;

    let numerator = amount_in_with_fee
        .checked_mul(reserve_out_u128)
        .ok_or(MultiHopperError::MathOverflow)?;

    let denominator = reserve_in_u128
        .checked_mul(BASIS_POINTS_DIVISOR as u128)
        .ok_or(MultiHopperError::MathOverflow)?
        .checked_add(amount_in_with_fee)
        .ok_or(MultiHopperError::MathOverflow)?;

    let amount_out = numerator
        .checked_div(denominator)
        .ok_or(MultiHopperError::MathOverflow)? as u64;

    Ok(amount_out)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RouteStep {
    pub pool_source_reserve: u64,
    pub pool_destination_reserve: u64,
    pub pool_fee_bps: u64,
}

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub protocol_fee_bps: u64,
    pub total_volume_usd: u64,
    pub total_swaps: u64,
    pub bump: u8,
}

impl ProtocolConfig {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
}

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: Protocol Treasury recipient account
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteMultiHopSwap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub input_mint: AccountInfo<'info>,
    pub output_mint: AccountInfo<'info>,

    #[account(
        mut,
        constraint = user_source_token_account.owner == user.key(),
        constraint = user_source_token_account.mint == input_mint.key()
    )]
    pub user_source_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = intermediary_vault_0.owner == config.key()
    )]
    pub intermediary_vault_0: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = final_settlement_vault.owner == config.key(),
        constraint = final_settlement_vault.mint == output_mint.key()
    )]
    pub final_settlement_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_final_output_account.owner == user.key(),
        constraint = user_final_output_account.mint == output_mint.key()
    )]
    pub user_final_output_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = treasury_token_account.mint == output_mint.key()
    )]
    pub treasury_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = integrator_token_account.mint == output_mint.key()
    )]
    pub integrator_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[event]
pub struct SwapExecuted {
    pub user: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub protocol_fee: u64,
    pub integrator_fee: u64,
    pub hops_count: u8,
    pub timestamp: i64,
}

#[error_code]
pub enum MultiHopperError {
    #[msg("Input token amount must be greater than zero.")]
    ZeroAmountIn,
    #[msg("Route must contain at least one hop.")]
    EmptyRoute,
    #[msg("Route length exceeds maximum allowed hops.")]
    RouteTooLong,
    #[msg("Specified fee basis points exceed safety ceiling.")]
    FeeExceedsCeiling,
    #[msg("A single hop resulted in zero token output.")]
    ZeroHopOutput,
    #[msg("Trade slippage tolerance breached.")]
    SlippageExceeded,
    #[msg("Trade slippage breached after factoring in protocol/integrator fees.")]
    SlippageExceededAfterFees,
    #[msg("Arithmetic overflow occurred during hop computation.")]
    MathOverflow,
    #[msg("Pool reserve cannot be zero.")]
    InvalidReserves,
}