import fs from 'node:fs';
const policy=JSON.parse(fs.readFileSync('src/lib/editorial/product-reference-policy.json','utf8'));
let text='{% doc %}\n  Verified article example families. Generated from product-reference-policy.json.\n  @param {string} handle\n{% enddoc %}\n{%- case handle -%}\n';
for(const [handle,rule] of Object.entries(policy))if(rule.fallbacks.length){
 if(!/^[\p{L}\p{N}-]+$/u.test(handle)||/[|<>]/.test(rule.vendor+rule.type))throw Error('unsafe policy');
 const candidates=rule.fallbacks.map(h=>{if(!policy[h]||policy[h].family!==rule.family||!/^[0-9]+$/.test(policy[h].id))throw Error('invalid fallback');return h+':'+policy[h].id;});
 text+=`{%- when "${handle}" -%}${rule.vendor}|${rule.type}|${candidates.join(',')}\n`;
}
text+='{%- endcase -%}\n';
fs.writeFileSync('shopify/snippets/toptik-article-example-policy.liquid',text);
