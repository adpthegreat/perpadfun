UPDATE public.tokens
SET position_collateral_usd = opened_collateral_usd,
    position_size_usd       = opened_collateral_usd * leverage,
    pnl_high_water_usd      = 0,
    treasury_pnl_usd        = 0
WHERE ticker IN ('HYPU','PAMP','PUMPED','SHIRO','UPDOG')
  AND router = 'imperial';