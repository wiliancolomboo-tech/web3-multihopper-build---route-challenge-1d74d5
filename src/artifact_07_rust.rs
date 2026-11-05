use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub base_fee_bps: u16,        // e.g. 30 = 0.3%
    pub partner_share_bps: u16,   // e.g. 5000 = 50% of the base fee goes to partner
    pub is_paused: bool,
    pub bump: u8,
}

impl GlobalConfig {
    pub const LEN: usize = 8 + 32 + 32 + 2 + 2 + 1 + 1; // 76 bytes
}

#[account]
#[derive(Default)]
pub struct PartnerVault {
    pub partner: Pubkey,
    pub token_mint: Pubkey,
    pub accumulated_rewards: u64,
    pub bump: u8,
}

impl PartnerVault {
    pub const LEN: usize = 8 + 32 + 32 + 8 + 1; // 81 bytes
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct HopConfig {
    pub pool_program_id: Pubkey,
    pub intermediate_mint: Pubkey,
}