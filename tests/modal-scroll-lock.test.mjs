import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const code = stripTypeScriptTypes(readFileSync('src/lib/carousel/modal-scroll-lock.ts', 'utf8'));
const { lockModalScroll } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function style(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key,value])=>[key,[value,'']]));
  return {
    getPropertyValue: key => values.get(key)?.[0] ?? '',
    getPropertyPriority: key => values.get(key)?.[1] ?? '',
    setProperty: (key,value,priority='') => values.set(key,[value,priority]),
    removeProperty: key => values.delete(key),
  };
}
function fixture() {
  const calls=[];
  const body=style({position:'relative',width:'94%'});
  const root=style();
  root.setProperty('overflow','clip','important');
  return { document:{body:{style:body,dataset:{}},documentElement:{style:root}},scrollX:13,scrollY:1179,
    scrollTo: value=>calls.push(value),calls };
}
test('closing a dialog preserves the original position, inline styles and priorities',()=>{
  const win=fixture(); const release=lockModalScroll(win);
  assert.equal(win.document.body.style.getPropertyValue('top'),'-1179px');
  assert.equal(win.document.body.style.getPropertyValue('position'),'fixed');
  assert.equal(win.document.body.dataset.modalScrollY,'1179');
  release();
  assert.equal(win.document.body.style.getPropertyValue('position'),'relative');
  assert.equal(win.document.body.style.getPropertyValue('width'),'94%');
  assert.equal(win.document.body.style.getPropertyValue('top'),'');
  assert.equal(win.document.body.dataset.modalScrollY,undefined);
  assert.equal(win.document.documentElement.style.getPropertyPriority('overflow'),'important');
  assert.deepEqual(win.calls,[{left:13,top:1179,behavior:'instant'}]);
});
test('cleanup is idempotent and reopening captures the new scroll position',()=>{
  const win=fixture(); const release=lockModalScroll(win);release();release();
  assert.equal(win.calls.length,1);
  win.scrollY=400;const second=lockModalScroll(win);second();
  assert.equal(win.calls[1].top,400);
});
