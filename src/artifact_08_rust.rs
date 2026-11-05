use anchor_lang::prelude::*;
use crate::state::GlobalConfig;
use crate::errors::MultiHopperError;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = GlobalConfig::LEN,
        seeds = [b"global-config"],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Protocol treasury address that receives fees
    pub treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Initialize>,
    base_fee_bps: u16,
    partner_share_bps: u16,
) -> Result<()> {
    require!(base_fee_bps <= 500, MultiHopperError::FeeTooHigh);
    require!(partner_share_bps <= 10_000, MultiHopperError::InvalidRevShareSplit);

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.treasury = ctx.accounts.treasury.key();
    config.base_fee_bps = base_fee_bps;
    config.partner_share_bps = partner_share_bps;
    config.is_paused = false;
    config.bump = ctx.bumps.config;

    msg!("MultiHopper Global Configuration initialized successfully.");
    Ok(())
}