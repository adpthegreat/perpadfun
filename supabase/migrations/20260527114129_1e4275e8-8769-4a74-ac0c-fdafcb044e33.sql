CREATE OR REPLACE FUNCTION public.guard_imperial_position_inflation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  safe_coll numeric;
  safe_leverage numeric;
  max_safe_size numeric;
BEGIN
  IF lower(coalesce(NEW.router, '')) = 'imperial' THEN
    IF coalesce(OLD.position_collateral_usd, 0) > 0
       AND coalesce(NEW.position_collateral_usd, 0) > coalesce(OLD.position_collateral_usd, 0) + 50
    THEN
      NEW.position_collateral_usd := OLD.position_collateral_usd;
      NEW.position_size_usd := OLD.position_size_usd;
    END IF;

    safe_coll := greatest(coalesce(NEW.position_collateral_usd, 0), 0);
    safe_leverage := greatest(coalesce(NEW.leverage, OLD.leverage, 1), 1);
    max_safe_size := safe_coll * safe_leverage;

    IF safe_coll > 0
       AND coalesce(NEW.position_size_usd, 0) > max_safe_size + greatest(1, max_safe_size * 0.01)
    THEN
      NEW.position_size_usd := max_safe_size;
    END IF;

    IF safe_coll = 0 THEN
      NEW.position_size_usd := 0;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

UPDATE public.tokens
SET position_size_usd = position_collateral_usd * greatest(leverage, 1)
WHERE lower(coalesce(router, '')) = 'imperial'
  AND coalesce(position_collateral_usd, 0) > 0
  AND coalesce(position_size_usd, 0) > (position_collateral_usd * greatest(leverage, 1)) + greatest(1, (position_collateral_usd * greatest(leverage, 1)) * 0.01);

UPDATE public.tokens
SET position_size_usd = 0
WHERE lower(coalesce(router, '')) = 'imperial'
  AND coalesce(position_collateral_usd, 0) = 0
  AND coalesce(position_size_usd, 0) <> 0;