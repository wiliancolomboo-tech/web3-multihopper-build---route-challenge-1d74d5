use anchor_lang::prelude::*;
use crate::state::ProtocolConfig;
use crate::errors::MultiHopperError;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = ProtocolConfig::LEN,
        seeds = [b"multi_hopper_config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Safe treasury/fee recipient account
    pub fee_recipient: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeProtocol>, fee_bps: u16) -> Result<()> {
    require!(fee_bps <= 500, MultiHopperError::MathOverflow); // Max 5% protocol fee safeguard

    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.fee_recipient = ctx.accounts.fee_recipient.key();
    config.fee_bps = fee_bps;
    config.is_paused = false;
    config.total_volume_swapped = 0;
    config.total_hops_executed = 0;
    config.bump = ctx.bumps.config;

    msg!("MultiHopper Engine Initialized. Admin: {}", config.admin);
    Ok(())
}