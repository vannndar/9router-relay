import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { gunzipSync } from 'node:zlib';
import vm from 'node:vm';
import { normalizePiece, canPlace, applyPlacement, solveBoard } from '../web/solver-core.mjs';
import { detectScreenshot, findBoardRect, readBoard, readPiece } from '../web/solver-image.mjs';
import { createApplication } from '../lib/web.mjs';
import { enableGridPainting } from '../web/grid-paint.mjs';

test('placement preserves orientation, handles bit 7, and clears crossing lines together without gravity', () => {
  const board = [254, 1, 1, 1, 1, 1, 1, 1], dot = normalizePiece([[1]]);
  const result = applyPlacement(board, dot, 0, 0);
  assert.deepEqual(result.clearedRows, [0]); assert.deepEqual(result.clearedCols, [0]);
  assert.deepEqual(result.board, Array(8).fill(0)); assert.deepEqual(board, [254, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(applyPlacement(Array(8).fill(0), normalizePiece([[1,1]]), 0, 7), null);
  assert.equal(applyPlacement([128,0,0,0,0,0,0,0], dot, 0, 7), null);
  assert.equal(canPlace(Array(8).fill(0), normalizePiece([[1],[1]]), 7, 0), false);
  const square = normalizePiece([[1,1],[1,1]]);
  const stable = applyPlacement([252,252,128,0,0,0,0,0], square, 0, 0);
  assert.deepEqual(stable.clearedRows, [0,1]); assert.equal(stable.board[2], 128);
  const diagonal = normalizePiece([[0,0,0],[0,1,0],[0,0,1]]);
  assert.deepEqual(diagonal.matrix, [[1,0],[0,1]], 'disconnected diagonal cells are valid exact shapes');
});

test('solver finds a small-piece-first rescue, supports missing slots and deterministic duplicates', () => {
  // There is no 3x3 space until the dot completes and clears the third row.
  const board = [0,0,254,170,85,170,85,170];
  const square = [[1,1,1],[1,1,1],[1,1,1]];
  const result = solveBoard(board, [square, null, [[1]]]);
  assert.equal(result.placedCount, 2); assert.equal(result.moves[0].pieceIndex, 2);
  assert.deepEqual(result.moves[0].clearedRows, [2]); assert.equal(result.moves[1].pieceIndex, 0);
  let replay = board;
  for (const move of result.moves) {
    const piece = normalizePiece([square, null, [[1]]][move.pieceIndex]);
    const next = applyPlacement(replay, piece, move.row, move.col);
    assert(next); assert.deepEqual(next.board, move.board); replay = next.board;
  }
  const first = solveBoard(Array(8).fill(0), [[[1]], [[1]], [[1]]]);
  const second = solveBoard(Array(8).fill(0), [[[1]], [[1]], [[1]]]);
  assert.deepEqual(first.moves, second.moves); assert.deepEqual(board, [0,0,254,170,85,170,85,170]);
  const blocked = solveBoard([170,85,170,85,170,85,170,85], [[[1,1],[1,1]]]);
  assert.equal(blocked.placedCount, 0); assert.deepEqual(blocked.remainingIndices, [0]);
  assert.throws(() => solveBoard([255,0,0,0,0,0,0,0], [[[1]]]), /garis yang sudah penuh/);
  assert.throws(() => solveBoard(Array(8).fill(0), [null]), /sedikitnya satu/);
});

// An independent cell-based reference enumerator checks search completeness,
// rather than calling the production placement/clearing implementation.
function referenceCount(rows, shapes) {
  let best = 0;
  function walk(board, remaining, count) {
    best = Math.max(best, count);
    remaining.forEach((shape, index) => {
      const cells = shape.flatMap((row,r) => row.flatMap((v,c) => v ? [[r,c]] : []));
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if (cells.some(([dr,dc]) => r+dr >= 8 || c+dc >= 8 || board[r+dr][c+dc])) continue;
        const next = board.map(row => row.slice());
        cells.forEach(([dr,dc]) => { next[r+dr][c+dc] = true; });
        const fullRows = next.map(row => row.every(Boolean));
        const fullCols = Array.from({length:8},(_,c) => next.every(row => row[c]));
        next.forEach((row,rr) => row.forEach((_,cc) => { if (fullRows[rr] || fullCols[cc]) next[rr][cc] = false; }));
        walk(next, remaining.filter((_,i) => i !== index), count+1);
      }
    });
  }
  walk(rows.map(bits => Array.from({length:8},(_,c) => Boolean(bits & (1<<c)))), shapes, 0);
  return best;
}

test('search matches an independent enumerator on crowded boards and partial solutions', () => {
  const shapes = [[[1,1,1]], [[1],[1],[1]], [[1,1],[1,0]]];
  let seed = 20261109;
  for (let sample = 0; sample < 12; sample++) {
    const board = Array.from({length:8}, () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return ((seed>>>16)&255) & 254; });
    const fullColumns = board.reduce((mask,row) => mask & row,255);
    board.forEach((row,r) => { board[r] = row & ~fullColumns; });
    assert.equal(solveBoard(board, shapes).placedCount, referenceCount(board, shapes), `sample ${sample}`);
  }
});

function screenshotFixture(scale = 1, color = [70,145,225]) {
  const width = Math.round(400*scale), height = Math.round(800*scale), data = new Uint8ClampedArray(width*height*4);
  function rectangle(x,y,w,h,rgb) {
    for(let yy=Math.round(y*scale); yy<Math.round((y+h)*scale); yy++) for(let xx=Math.round(x*scale);xx<Math.round((x+w)*scale);xx++) {
      const i=(yy*width+xx)*4; data.set([...rgb,255],i);
    }
  }
  rectangle(0,0,400,800,[29,41,78]);
  const board=[21,82,130,17,44,192,10,65];
  for(let r=0;r<8;r++) for(let c=0;c<8;c++) rectangle(20+c*45+2,200+r*45+2,41,41,board[r]&(1<<c)?color:[37,51,88]);
  const shapes=[[[1,1,1],[1,1,1],[1,1,1]],[[1,1,1],[1,0,0]],[[1,0],[1,1]]];
  shapes.forEach((shape,index)=>shape.forEach((row,r)=>row.forEach((v,c)=>{if(v) rectangle(40+index*120+c*25,600+r*25,23,23,[210,150,45]);})));
  return {image:{width,height,data},board,shapes,rect:{x:20*scale,y:200*scale,width:360*scale,height:360*scale}};
}

test('local screenshot recognition reads 8x8 grids and exact piece orientations at multiple scales', () => {
  for (const scale of [1,1.5]) {
    const fixture = screenshotFixture(scale);
    const detected = findBoardRect(fixture.image);
    assert(Math.abs(detected.x-fixture.rect.x)<5*scale, JSON.stringify(detected));
    assert(Math.abs(detected.y-fixture.rect.y)<5*scale, JSON.stringify(detected));
    assert.deepEqual(readBoard(fixture.image,detected).board,fixture.board);
    for(let i=0;i<3;i++) {
      const piece=readPiece(fixture.image,{x:(20+i*120)*scale,y:580*scale,width:120*scale,height:100*scale},45*scale);
      assert.deepEqual(piece.matrix,fixture.shapes[i],`piece ${i}, scale ${scale}`);
    }
  }
  const blank={width:240,height:480,data:new Uint8ClampedArray(240*480*4)};
  assert.equal(readPiece(blank,{x:0,y:0,width:80,height:80},25).matrix,null);
  assert.doesNotThrow(()=>detectScreenshot(blank));
});

test('real Classic screenshot detects the whole board rather than a crop shifted by entire rows', () => {
  const image={width:647,height:1400,data:gunzipSync(readFileSync(new URL('./fixtures/classic-example.rgba.gz',import.meta.url)))};
  const detection=detectScreenshot(image);
  assert.deepEqual(detection.board,[135,31,31,15,1,121,113,252]);
  assert.deepEqual(detection.pieces.map(piece=>piece.matrix),[
    [[1,1],[1,1]],[[0,1],[0,1],[1,1]],[[1,1,1],[0,0,1],[0,0,1]],
  ]);
  assert(Math.abs(detection.rect.y-328)<5);
  const solution=solveBoard(detection.board,detection.pieces.map(piece=>piece.matrix));
  assert.equal(solution.placedCount,3);
});

test('legacy room links preserve the fragment and move to /paste without server transmission', () => {
  const script=readFileSync(new URL('../web/solver.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  let target;
  vm.runInNewContext(script,{URLSearchParams,location:{pathname:'/',hash:'#r=abcdefghijklmnopqrstuv',replace:value=>{target=value;}}});
  assert.equal(target,'/paste#r=abcdefghijklmnopqrstuv');
});

test('routing separates pages, serves worker modules, and preserves relay authentication', async () => {
  const calls=[];
  const app=createApplication({relay:async request=>{calls.push(new URL(request.url).pathname);return new Response('relay',{status:401});},paste:async()=>Response.json({notes:[]})});
  const home=await app(new Request('https://solver.example/'));
  assert.match(await home.text(),/id="board"/); assert.match(home.headers.get('content-security-policy'),/worker-src 'self'/);
  for (const path of ['/paste','/chat','/paste/','/chat/']) assert.match(await (await app(new Request(`https://solver.example${path}`))).text(),/id="pastePanel"/);
  for (const path of ['/solver.mjs','/solver-core.mjs','/solver-image.mjs','/solver-worker.mjs','/grid-paint.mjs']) assert.equal((await app(new Request(`https://solver.example${path}`))).status,200);
  assert.equal((await app(new Request('https://solver.example/v1/models'))).status,401);
  assert.deepEqual(calls,['/v1/models']);
  assert.equal((await app(new Request('https://solver.example/chat',{method:'POST'}))).status,405);
});

test('solver UI validates review, computes steps, invalidates edits, and applies the final board locally', async () => {
  const html=readFileSync(new URL('../web/solver.html',import.meta.url),'utf8');
  const script=readFileSync(new URL('../web/solver.mjs',import.meta.url),'utf8')
    .replace("import { normalizePiece } from './solver-core.mjs';",'const { normalizePiece } = window.testHelpers;')
    .replace("import { detectScreenshot, readBoard, readPiece } from './solver-image.mjs';",'const { detectScreenshot, readBoard, readPiece } = window.testHelpers;')
    .replace("import { enableGridPainting } from './grid-paint.mjs';",'const { enableGridPainting } = window.testHelpers;');
  const dom=new JSDOM(html,{url:'https://solver.example/',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom, get=id=>window.document.getElementById(id);
  let active=0,transmissions=0,lastResult=null;
  const requests=[];
  window.fetch=()=>{transmissions++;assert.fail('solver must not upload or request a model');};
  window.testHelpers={normalizePiece,detectScreenshot,readBoard,readPiece,enableGridPainting};
  window.Storage.prototype.setItem=()=>assert.fail('solver must not persist images or boards');
  window.Worker=class {
    constructor(){active++;}
    postMessage(data){requests.push(data);setImmediate(()=>{lastResult=solveBoard(data.board,data.pieces,{comboRemaining:data.comboRemaining});this.onmessage?.({data:{type:'result',result:lastResult}});});}
    terminate(){active--;}
  };
  try {
    window.eval(script);
    assert.equal(get('board').children.length,64); assert.equal(get('pieceEditors').querySelectorAll('.piece-cell').length,75);
    assert.equal(get('comboChance').value,'3');
    get('solveButton').click(); assert.match(get('solveNotice').textContent,/Periksa papan/);
    get('exampleButton').click(); get('solveButton').click();
    for(let i=0;i<20&&get('results').hidden;i++) await new Promise(setImmediate);
    assert.equal(get('results').hidden,false); assert.match(get('resultBadge').textContent,/3 \/ 3/); assert.equal(active,0);
    assert.equal(requests.at(-1).comboRemaining,3);
    get('comboChance').value='1';get('comboChance').dispatchEvent(new window.Event('change'));
    assert.equal(get('results').hidden,true);assert.equal(get('reviewedInput').checked,true);
    assert.match(get('comboHint').textContent,/berikutnya harus pecah/);
    get('solveButton').click();
    for(let i=0;i<20&&get('results').hidden;i++)await new Promise(setImmediate);
    assert.equal(get('results').hidden,false);assert.equal(requests.at(-1).comboRemaining,1);
    get('nextStep').click(); assert.match(get('previewLabel').textContent,/Langkah 2/);
    get('finalPreview').click(); assert.equal(get('previewLabel').textContent,'Papan akhir');
    get('useFinalBoard').click(); assert.equal(get('results').hidden,true); assert.equal(get('pieceEditors').querySelectorAll('.piece-cell.filled').length,0);
    assert.equal(get('comboChance').value,String(lastResult.combo.remaining));
    get('exampleButton').click(); get('solveButton').click(); get('board').children[0].click();
    await new Promise(setImmediate); assert.equal(get('results').hidden,true); assert.equal(active,0); assert.equal(get('reviewedInput').checked,false);
    assert.equal(transmissions,0);
  } finally {window.dispatchEvent(new window.Event('pagehide'));dom.window.close();}
});
