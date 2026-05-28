CREATE OR REPLACE FUNCTION public.guard_imperial_position_inflation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF lower(coalesce(NEW.router, '')) = 'imperial'
     AND coalesce(OLD.position_collateral_usd, 0) > 0
     AND coalesce(NEW.position_collateral_usd, 0) > coalesce(OLD.position_collateral_usd, 0) + 50
  THEN
    NEW.position_collateral_usd := OLD.position_collateral_usd;
    NEW.position_size_usd := OLD.position_size_usd;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_imperial_position_inflation_trigger ON public.tokens;
CREATE TRIGGER guard_imperial_position_inflation_trigger
BEFORE UPDATE OF position_collateral_usd, position_size_usd ON public.tokens
FOR EACH ROW
EXECUTE FUNCTION public.guard_imperial_position_inflation();