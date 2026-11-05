use anchor_lang::prelude::*;

#[error_code]
pub enum MultiHopperError {
    #[msg("Protocol is currently paused by admin.")]
    ProtocolPaused,
    #[msg("Fee basis points exceeds maximum allowed threshold (500 bps = 5%).")]
    FeeTooHigh,
    #[msg("Revenue share partner split exceeds 10,000 basis points (100%).")]
    InvalidRevShareSplit,
    #[msg("Slippage limit violated: output amount is strictly lower than min_amount_out.")]
    SlippageExceeded,
    #[msg("Hop count cannot be zero and cannot exceed maximum supported hops (4).")]
    InvalidHopCount,
    #[msg("Route accounts provided do not match the expected hop count.")]
    MismatchedRouteAccounts,
    #[msg("Numerical overflow occurred during fee or slippage calculation.")]
    MathOverflow,
    #[msg("No revenue share rewards available for withdrawal.")]
    ZeroClaimableRewards,
    #[msg("Unauthorized signer for administrative instruction.")]
    Unauthorized,
}