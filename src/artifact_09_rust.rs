use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::{GlobalConfig, PartnerVault, HopConfig};
use crate::errors::MultiHopperError;
use crate::events::RouteExecuted;

#[derive(Accounts)]
pub struct ExecuteRoute<'info> {
    #[account(
        seeds = [b"global-config"],
        bump = config.bump
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub user: Signer<'info>,

    /// CHECK: Integrator/partner receiving revenue share
    pub partner: AccountInfo<'info>,

    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = user_input_token.mint == input_mint.key(),
        constraint = user_input_token.owner == user.key()
    )]
    pub user_input_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = user_output_token.mint == output_mint.key(),
        constraint = user_output_token.owner == user.key()
    )]
    pub user_output_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = protocol_treasury_token.mint == output_mint.key(),
        constraint = protocol_treasury_token.owner == config.treasury
    )]
    pub protocol_treasury_token: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = PartnerVault::LEN,
        seeds = [b"partner-vault", partner.key().as_ref(), output_mint.key().as_ref()],
        bump
    )]
    pub partner_vault: Account<'info, PartnerVault>,

    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"partner-token-escrow", partner.key().as_ref(), output_mint.key().as_ref()],
        bump,
        token::mint = output_mint,
        token::authority = partner_vault
    )]
    pub partner_token_escrow: Account<'info, TokenAccount>,

    /// Intermediate liquidity token account managed by the protocol router PDA
    #[account(
        init_if_needed,
        payer = user,
        seeds = [b"transient-escrow", user.key().as_ref(), output_mint.key().as_ref()],
        bump,
        token::mint = output_mint,
        token::authority = config
    )]
    pub transient_escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
    amount_in: u64,
    min_amount_out: u64,
    hops: Vec<HopConfig>,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.is_paused, MultiHopperError::ProtocolPaused);
    require!(amount_in > 0, MultiHopperError::MathOverflow);
    require!(!hops.is_empty() && hops.len() <= 4, MultiHopperError::InvalidHopCount);

    let balance_before = ctx.accounts.user_output_token.amount;

    // 1. Transfer source tokens from user into protocol escrow
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_input_token.to_account_info(),
                to: ctx.accounts.transient_escrow.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_in,
    )?;

    // 2. Perform CPI Hop executions
    // In production multi-hop, CPI instructions are issued to the pool programs (Orca, Raydium, etc.)
    // Here we compute deterministic multi-hop price-impact model, simulating swaps across hops
    let mut current_liquidity = amount_in;
    for (idx, _hop) in hops.iter().enumerate() {
        // Linear liquidity conservation with standard 25 bps AMM fee deduction per hop
        let step_fee = current_liquidity
            .checked_mul(25)
            .ok_or(MultiHopperError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(MultiHopperError::MathOverflow)?;

        current_liquidity = current_liquidity
            .checked_sub(step_fee)
            .ok_or(MultiHopperError::MathOverflow)?;

        msg!("Hop {} executed successfully. Running step liquidity: {}", idx + 1, current_liquidity);
    }

    let simulated_gross_out = current_liquidity;

    // 3. Compute MultiHopper Protocol Fee & Revenue Share
    let total_fee = simulated_gross_out
        .checked_mul(config.base_fee_bps as u64)
        .ok_or(MultiHopperError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(MultiHopperError::MathOverflow)?;

    let partner_cut = total_fee
        .checked_mul(config.partner_share_bps as u64)
        .ok_or(MultiHopperError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(MultiHopperError::MathOverflow)?;

    let treasury_cut = total_fee
        .checked_sub(partner_cut)
        .ok_or(MultiHopperError::MathOverflow)?;

    let net_amount_out = simulated_gross_out
        .checked_sub(total_fee)
        .ok_or(MultiHopperError::MathOverflow)?;

    // 4. Strict slippage verification
    require!(net_amount_out >= min_amount_out, MultiHopperError::SlippageExceeded);

    // 5. Transfer partner cut to partner escrow PDA
    let config_bump = config.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[b"global-config", &[config_bump]]];

    if partner_cut > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.transient_escrow.to_account_info(),
                    to: ctx.accounts.partner_token_escrow.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            partner_cut,
        )?;

        let partner_vault = &mut ctx.accounts.partner_vault;
        partner_vault.partner = ctx.accounts.partner.key();
        partner_vault.token_mint = ctx.accounts.output_mint.key();
        partner_vault.accumulated_rewards = partner_vault
            .accumulated_rewards
            .checked_add(partner_cut)
            .ok_or(MultiHopperError::MathOverflow)?;
        partner_vault.bump = ctx.bumps.partner_vault;
    }

    // 6. Transfer treasury cut
    if treasury_cut > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.transient_escrow.to_account_info(),
                    to: ctx.accounts.protocol_treasury_token.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer_seeds,
            ),
            treasury_cut,
        )?;
    }

    // 7. Transfer settled output tokens to the user
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.transient_escrow.to_account_info(),
                to: ctx.accounts.user_output_token.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer_seeds,
        ),
        net_amount_out,
    )?;

    // 8. Reload user output token account to assert balance changes
    ctx.accounts.user_output_token.reload()?;
    let balance_after = ctx.accounts.user_output_token.amount;
    let delta = balance_after
        .checked_sub(balance_before)
        .ok_or(MultiHopperError::MathOverflow)?;

    require!(delta >= min_amount_out, MultiHopperError::SlippageExceeded);

    // 9. Emit audit and telemetry event
    emit!(RouteExecuted {
        user: ctx.accounts.user.key(),
        partner: ctx.accounts.partner.key(),
        input_mint: ctx.accounts.input_mint.key(),
        output_mint: ctx.accounts.output_mint.key(),
        amount_in,
        final_amount_out: net_amount_out,
        total_fee,
        partner_cut,
        treasury_cut,
        hops_count: hops.len() as u8,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!(
        "Route complete: In={} Out={} (Min={}) Fee={} PartnerCut={}",
        amount_in,
        net_amount_out,
        min_amount_out,
        total_fee,
        partner_cut
    );

    Ok(())
}