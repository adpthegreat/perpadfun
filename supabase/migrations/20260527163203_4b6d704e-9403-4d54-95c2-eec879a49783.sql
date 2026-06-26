create or replace function public.guard_imperial_position_inflation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  safe_coll numeric;
  safe_leverage numeric;
  max_safe_size numeric;
begin
  if lower(coalesce(new.router, '')) = 'imperial' then
    safe_coll := greatest(coalesce(new.position_collateral_usd, 0), 0);
    safe_leverage := greatest(coalesce(new.leverage, old.leverage, 1), 1);

    -- Imperial reports live notional at mark price, so it can legitimately
    -- drift above collateral * selected leverage. Only clamp obvious runaway
    -- inflation while preserving real venue state.
    max_safe_size := safe_coll * safe_leverage * 1.25;

    if safe_coll > 0
       and coalesce(new.position_size_usd, 0) > max_safe_size + greatest(25, max_safe_size * 0.02)
    then
      new.position_size_usd := max_safe_size;
    end if;

    if safe_coll = 0 then
      new.position_size_usd := 0;
    end if;
  end if;

  return new;
end;
$$;