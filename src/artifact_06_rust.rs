use anchor_lang::prelude::*;

#[event]
pub struct RouteExecuted {
    pub user: Pubkey,
    pub partner: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub final_amount_out: u64,
    pub total_fee: u64,
    pub partner_cut: u64,
    pub treasury_cut: u64,
    pub hops_count: u8,
    pub timestamp: i64,
}

#[event]
pub struct RevenueClaimed {
    pub partner: Pubkey,
    pub token_mint: Pubkey,
    pub amount_claimed: u64,
    pub timestamp: i64,
}