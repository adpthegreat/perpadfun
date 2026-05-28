update public.tokens
set imperial_profile_pda = 'pyHh1YJUW67YRRDyo1ceHMTmkPRMgQ52uYS6U1fw35v'
where ticker = 'HYPU' and router = 'imperial' and imperial_profile_pda is null;
