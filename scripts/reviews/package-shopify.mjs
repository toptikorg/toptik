import fs from 'node:fs';
import path from 'node:path';
import { validReviewBranches } from '../../src/components/reviews/review-widget.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const branches = JSON.parse(fs.readFileSync(path.join(root,'src/components/reviews/branches.json'),'utf8'));
if (!validReviewBranches(branches)) throw new Error('Release blocked: three verified Google review links and QR images are required');
for (const b of branches) if (!fs.existsSync(path.join(root,'public',b.qrPath))) throw new Error(`Missing QR ${b.id}`);
const css = fs.readFileSync(path.join(root,'src/components/reviews/review-widget.css'),'utf8');
const js = fs.readFileSync(path.join(root,'src/components/reviews/review-widget.mjs'),'utf8').replaceAll('export function ', 'function ');
const out = path.join(root,'shopify/reviews'); fs.mkdirSync(out,{recursive:true});
// Each site serves its own QR assets, without an external QR service.
const qrSources = branches.map(b => `${JSON.stringify(b.id)}: {{ 'toptik-review-${b.id}.svg' | asset_url | json }}`).join(',');
for (const b of branches) fs.copyFileSync(path.join(root,'public',b.qrPath),path.join(out,`toptik-review-${b.id}.svg`));
fs.writeFileSync(path.join(out,'toptik-google-reviews.liquid'),`{% doc %}\n  Verified branch review selector and QR codes. Render once before closing body.\n{% enddoc %}\n<style>\n${css}\n#toptik-header .tt-review-host{color:inherit;text-align:center}\n</style>\n<script>\n(() => {\n${js}\nconst nav=document.querySelector('#tt-main-nav');\nif(!nav || document.querySelector('.tt-review-host')) return;\nconst host=document.createElement('div'); host.className='tt-review-host'; nav.before(host);\nmountReviewWidget(host,${JSON.stringify(branches)}, {qrSources:{${qrSources}}});\n})();\n</script>\n`);
console.log('Prepared unpublished Shopify snippet. MAIN publication remains merchant-only.');
