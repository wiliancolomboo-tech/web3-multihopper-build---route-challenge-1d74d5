use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::HopConfig;

declare_id!("HoppEr1111111111111111111111111111111111111");

#[program]
pub mod multihopper {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        base_fee_bps: u16,
        partner_share_bps: u16,
    ) -> Result<()> {
        instructions::initialize::handler(ctx, base_fee_bps, partner_share_bps)
    }

    pub fn execute_route<'info>(
        ctx: Context<'_, '_, 'info, 'info, ExecuteRoute<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        hops: Vec<HopConfig>,
    ) -> Result<()> {
        instructions::execute_route::handler(ctx, amount_in, min_amount_out, hops)
    }

    pub fn claim_revenue(ctx: Context<ClaimRevenue>) -> Result<()> {
        instructions::claim_revenue::handler(ctx)
    }
}