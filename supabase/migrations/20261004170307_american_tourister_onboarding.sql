-- Add only the owner-approved public brand. Preserve every identity, lease,
-- media, publication, held-product, RLS and grant guard in the live function.
do $migration$
declare definition text; old_clause text := $$v_brand not in ('Mandarina Duck','Bric''s','Samsonite')$$;
begin
  select pg_get_functiondef('public.onboard_public_shopify_product(jsonb,uuid)'::regprocedure) into definition;
  if strpos(definition, old_clause)=0 then
    raise exception 'ONBOARDING_BRAND_BASELINE_CHANGED';
  end if;
  execute replace(definition, old_clause,
    $$v_brand not in ('Mandarina Duck','Bric''s','Samsonite','American Tourister')$$);
end
$migration$;
