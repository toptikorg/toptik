import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validReviewBranches, mountReviewWidget } from '../src/components/reviews/review-widget.mjs';
const fixture = () => ['gan','ramat','weiz'].map(id=>({id,name:id,address:'test',reviewUrl:`https://g.page/r/test_${id}/review`,qrPath:`/reviews/${id}.svg`,verified:true}));
test('three distinct verified branch links required',()=> {
  assert.equal(validReviewBranches(fixture()),true);
  assert.equal(validReviewBranches(fixture().slice(0,2)),false);
  const duplicate=fixture();duplicate[2].id='gan';assert.equal(validReviewBranches(duplicate),false);
});
test('missing or untrusted review destinations fail closed',()=> {
  for(const url of ['', 'javascript:alert(1)','https://g.page.evil.test/r/x/review','http://g.page/r/x/review','https://g.page/r/x/review?redirect=evil','https://user:pass@g.page/r/x/review']) {
    const b=fixture();b[0].reviewUrl=url;assert.equal(validReviewBranches(b),false,url);
  }
  const b=fixture();b[0].verified=false;assert.equal(validReviewBranches(b),false);
});
test('missing configuration does not mount a misleading public control',()=> {
  const b=JSON.parse(fs.readFileSync(new URL('../src/components/reviews/branches.json',import.meta.url),'utf8'));
  if(!validReviewBranches(b)) assert.doesNotThrow(()=>mountReviewWidget(null,b)());
});
test('QR and selector accessibility and purchase isolation remain explicit',()=> {
  const js=fs.readFileSync(new URL('../src/components/reviews/review-widget.mjs',import.meta.url),'utf8');
  assert.match(js,/dialog.showModal\(\)/);assert.match(js,/aria-labelledby/);assert.match(js,/qr.alt/);
  assert.match(js,/noopener noreferrer/);assert.match(js,/header details\[open\]/);
  assert.doesNotMatch(js,/fetch\(|XMLHttpRequest|localStorage|\/cart\/add|innerHTML/);
});
