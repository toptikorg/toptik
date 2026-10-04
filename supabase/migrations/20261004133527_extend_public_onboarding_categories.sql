-- Extend only the category validation of the existing atomic onboarding RPC.
-- Preserve its current body, owner, grants, security mode and all identity guards.
do $migration$
declare definition text; old_clause text := $$p_evidence->>'category' not in ('suitcase','carryon')$$;
begin
  select pg_get_functiondef('public.onboard_public_shopify_product(jsonb,uuid)'::regprocedure) into definition;
  if strpos(definition, old_clause)=0 then
    raise exception 'ONBOARDING_CATEGORY_BASELINE_CHANGED';
  end if;
  definition := replace(definition,old_clause,
    $$p_evidence->>'category' not in ('suitcase','carryon','fashion-bags','backpacks','laptop-bags','travel-bags','wallets','pouches')$$);
  execute definition;
end
$migration$;
