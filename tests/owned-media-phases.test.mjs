import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,plan,policy,refresh} from './helpers/owned-media-fixture.mjs';
import {phases} from './helpers/group-media-fixture.mjs';

function legacy(product){const f=fixture(product);
 // The reviewed Gallery map has a full per-color gallery, while the real native
 // association list historically contains just the primary for every color.
 for(const variant of f.source.variants){const color=f.manifest.variants.find(v=>v.variantGid===variant.variantGid);variant.mediaIds=[color.coverMediaId];}
 f.source=refresh(f.source);f.command.expectedSourceFingerprint=f.source.fingerprint;return f;
}
for(const product of [policy.FZT73_PRODUCT_GID,policy.MD20_PRODUCT_GID]){
 test(product+' no-op with legacy primary-only associations produces no native phases',()=>{
  const f=legacy(product),intent=plan.planOwnedMediaChange(f.source,f.manifest,f.command);
  assert.equal(intent.noop,true);assert.deepEqual(intent.impactedItemIds,[]);
  assert.deepEqual(phases.buildOwnedMediaPhaseSpecs(intent,f.source,{}),[]);
 });
 test(product+' target-only edit never appends or changes primary for an untouched color',()=>{
  const f=legacy(product),command={...f.command,desiredImages:[...f.command.desiredImages].reverse()};
  const intent=plan.planOwnedMediaChange(f.source,f.manifest,command),specs=phases.buildOwnedMediaPhaseSpecs(intent,f.source,{});
  assert.deepEqual(intent.impactedItemIds,[command.itemId]);
  const target=f.binding.variants.find(v=>v.itemId===command.itemId).variantGid;
  assert.equal(specs.some(spec=>spec.kind==='variant_append'),false);
  assert.ok(specs.some(spec=>spec.kind==='variant_cover'));
  assert.ok(specs.filter(spec=>spec.kind.startsWith('variant_')).every(spec=>spec.variantId===target));
  assert.ok(f.binding.variants.filter(v=>v.itemId!==command.itemId).every(v=>!specs.some(spec=>spec.variantId===v.variantGid)));
 });
 test(product+' explicit assignment affecting another color changes only that color native membership',()=>{
  const f=legacy(product),other=f.binding.variants[1],mediaId=f.manifest.variants[0].orderedMediaIds[0];
  const command={...f.command,assignments:[{mediaId,itemIds:[f.command.itemId,other.itemId]}]};
  const intent=plan.planOwnedMediaChange(f.source,f.manifest,command),specs=phases.buildOwnedMediaPhaseSpecs(intent,f.source,{});
  assert.deepEqual(intent.impactedItemIds,[other.itemId]);
  assert.equal(specs.some(spec=>spec.kind==='variant_append'),false);
  assert.equal(specs.some(spec=>spec.kind==='variant_cover'),false);
  assert.ok(specs.filter(spec=>spec.kind.startsWith('variant_')).every(spec=>spec.variantId===other.variantGid));
 });
}
