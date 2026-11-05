use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::PartnerVault;
use crate::errors::MultiHopperError;
use crate::events::RevenueClaimed;

#[derive(Accounts)]
pub struct ClaimRevenue<'info> {
    #[account(mut)]
    pub partner: Signer<'info>,

    pub token_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [b"partner-vault", partner.key().as_ref(), token_mint.key().as_ref()],
        bump = partner_vault.bump,
        has_one = partner @ MultiHopperError::Unauthorized,
        has_one = token_mint
    )]
    pub partner_vault: Account<'info, PartnerVault>,

    #[account(
        mut,
        seeds = [b"partner-token-escrow", partner.key().as_ref(), token_mint.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = partner_vault
    )]
    pub partner_token_escrow: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = partner_destination_token.mint == token_mint.key(),
        constraint = partner_destination_token.owner == partner.key()
    )]
    pub partner_destination_token: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimRevenue>) -> Result<()> {
    let partner_vault = &mut ctx.accounts.partner_vault;
    let claimable = partner_vault.accumulated_rewards;
    require!(claimable > 0, MultiHopperError::ZeroClaimableRewards);

    partner_vault.accumulated_rewards = 0;

    let partner_key = partner_vault.partner;
    let mint_key = partner_vault.token_mint;
    let bump = partner_vault.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        b"partner-vault",
        partner_key.as_ref(),
        mint_key.as_ref(),
        &[bump],
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.partner_token_escrow.to_account_info(),
                to: ctx.accounts.partner_destination_token.to_account_info(),
                authority: partner_vault.to_account_info(),
            },
            signer_seeds,
        ),
        claimable,
    )?;

    emit!(RevenueClaimed {
        partner: partner_key,
        token_mint: mint_key,
        amount_claimed: claimable,
        timestamp: Clock::get()?.unix_timestamp,
    });

    msg!("Claimed {} tokens for partner {}", claimable, partner_key);
    Ok(())
}