use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("HopRouter1111111111111111111111111111111111");

#[program]
pub mod multihopper_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        handle_initialize(ctx, fee_bps)
    }

    pub fn execute_multi_hop<'a, 'b, 'c, 'info>(
        ctx: Context<'a, 'b, 'c, 'info, ExecuteMultiHop<'info>>,
        amount_in: u64,
        min_amount_out: u64,
        deadline: i64,
        hops: Vec<HopPayload>,
    ) -> Result<()> {
        handle_execute_multi_hop(ctx, amount_in, min_amount_out, deadline, hops)
    }
}