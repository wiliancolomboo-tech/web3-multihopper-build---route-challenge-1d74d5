use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::*;

declare_id!("Hop1111111111111111111111111111111111111111");

#[program]
pub mod multi_hopper {
    use super::*;

    pub fn initialize(ctx: Context<InitializeProtocol>, fee_bps: u16) -> Result<()> {
        instructions::initialize::handler(ctx, fee_bps)
    }

    pub fn execute_route<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteRoute<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        hops: Vec<HopStep>,
    ) -> Result<()> {
        instructions::execute_route::handler(ctx, amount_in, min_amount_out, hops)
    }
}