import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { enableGridPainting } from '../web/grid-paint.mjs';

function fixture(columns=8,rows=8) {
  const dom=new JSDOM('<div id="grid"></div>',{pretendToBeVisual:true});
  const {window}=dom,grid=window.document.getElementById('grid'),values=Array(columns*rows).fill(false);
  let changes=0;
  for(let i=0;i<values.length;i++) {
    const cell=window.document.createElement('button');cell.dataset.cell=String(i);
    const left=(i%columns)*24,top=Math.floor(i/columns)*24;
    cell.getBoundingClientRect=()=>({left,top,right:left+20,bottom:top+20,width:20,height:20});grid.append(cell);
  }
  enableGridPainting(grid,{columns,rows,read:i=>values[i],write:(i,value)=>{values[i]=value;},onChange:()=>{changes++;}});
  function pointer(type,target,x,y,options={}) {
    const event=new window.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:options.button??0,buttons:options.buttons??(type==='pointerup'?0:1),detail:1});
    Object.defineProperty(event,'pointerId',{value:options.pointerId??1});
    Object.defineProperty(event,'isPrimary',{value:options.primary??true});
    Object.defineProperty(event,'pointerType',{value:options.pointerType??'mouse'});
    target.dispatchEvent(event);
  }
  return {dom,window,grid,values,pointer,changes:()=>changes};
}

test('a fast horizontal stroke fills skipped cells and retracing does not toggle them off',()=>{
  const f=fixture();
  try {
    f.pointer('pointerdown',f.grid.children[0],10,10);
    f.pointer('pointermove',f.window.document,178,10);
    f.pointer('pointermove',f.window.document,10,10);
    f.pointer('pointerup',f.window.document,10,10);
    f.grid.children[0].dispatchEvent(new f.window.MouseEvent('click',{bubbles:true,detail:1}));
    assert.deepEqual(f.values.slice(0,8),Array(8).fill(true));assert.equal(f.values.filter(Boolean).length,8);
    f.pointer('pointerdown',f.grid.children[0],10,10);
    f.pointer('pointermove',f.window.document,178,10);
    f.pointer('pointerup',f.window.document,178,10);
    assert.equal(f.values.filter(Boolean).length,0,'starting on a filled cell erases the whole stroke');
  } finally {f.dom.window.close();}
});

test('touch drawing covers diagonal paths and ends cleanly on cancel and pointer release',()=>{
  const f=fixture(5,5);
  try {
    f.pointer('pointerdown',f.grid.children[0],10,10,{pointerType:'touch'});
    f.pointer('pointermove',f.window.document,106,106,{pointerType:'touch'});
    assert.deepEqual(f.values.map((value,i)=>value?i:-1).filter(i=>i>=0),[0,6,12,18,24]);
    f.pointer('pointercancel',f.window.document,106,106,{pointerType:'touch'});
    f.pointer('pointermove',f.window.document,10,106,{pointerType:'touch'});
    assert.equal(f.values.filter(Boolean).length,5);
    f.pointer('pointerdown',f.grid.children[1],34,10);
    f.pointer('pointermove',f.window.document,34,106,{buttons:0});
    f.pointer('pointermove',f.window.document,58,106);
    assert.equal(f.values.filter(Boolean).length,6,'movement after release must not continue drawing');
  } finally {f.dom.window.close();}
});

test('paint clips off-grid movement, ignores other pointers and secondary buttons, and preserves keyboard clicks',()=>{
  const f=fixture();
  try {
    f.pointer('pointerdown',f.grid.children[0],10,10,{button:2});assert.equal(f.changes(),0);
    f.pointer('pointerdown',f.grid.children[0],10,10);
    f.pointer('pointermove',f.window.document,10,178,{pointerId:2});assert.equal(f.values.filter(Boolean).length,1);
    f.pointer('pointermove',f.window.document,10000000,10);
    assert.equal(f.values.filter(Boolean).length,8);
    f.pointer('pointermove',f.window.document,10000000,178);
    assert.equal(f.values.filter(Boolean).length,8,'outside movement must not paint the right edge');
    f.pointer('pointerup',f.window.document,10000000,178);
    f.grid.children[8].click();assert.equal(f.values[8],true);
    f.grid.children[8].click();assert.equal(f.values[8],false);
  } finally {f.dom.window.close();}
});

test('a new stroke uses one fill or erase mode across mixed cells and blur stops painting',()=>{
  const f=fixture();
  try {
    f.values[1]=true;f.values[3]=true;
    f.pointer('pointerdown',f.grid.children[0],10,10);
    f.pointer('pointermove',f.window.document,106,10);
    assert.deepEqual(f.values.slice(0,5),Array(5).fill(true));
    f.window.dispatchEvent(new f.window.Event('blur'));
    f.pointer('pointermove',f.window.document,178,10);
    assert.equal(f.values.filter(Boolean).length,5);
  } finally {f.dom.window.close();}
});
