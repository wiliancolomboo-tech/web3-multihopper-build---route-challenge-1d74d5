use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AmmType {
    OrcaWhirlpool,
    RaydiumAmmV4,
    RaydiumClmm,
    MeteoraDlmm,
    ConstantProductMock,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct HopStep {
    pub amm_type: AmmType,
    pub pool_program_id: Pubkey,
    pub expected_output: u64,
    pub min_output_for_hop: u64,
}

#[event]
pub struct RouteExecutionEvent {
    pub user: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub min_amount_out: u64,
    pub hop_count: u8,
    pub timestamp: i64,
}