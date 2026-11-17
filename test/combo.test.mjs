import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComboRemaining, advanceCombo, solveBoard } from '../web/solver-core.mjs';
import { solveStrategicBoard } from '../web/solver-strategy.mjs';

const dots = [[[1]],[[1]],[[1]]];
const twoGaps = [252,249,243,231,207,159,63,126];

test('combo countdown accepts 1/2/3, defaults missing values to 3, and resets on any clear',()=>{
  for(const value of [undefined,null,'','  ']) assert.equal(normalizeComboRemaining(value),3);
  for(const value of [1,2,3,'1','2','3']) assert.equal(normalizeComboRemaining(value),Number(value));
  for(const value of [0,4,-1,1.5,NaN,'bad',false,[]]) assert.throws(()=>normalizeComboRemaining(value),/1, 2, atau 3/);
  let remaining=3,breaks=0;
  for(const lines of [0,0,1,0,0,0,2]) {
    const next=advanceCombo(remaining,lines);remaining=next.remaining;breaks+=Number(next.broken);
  }
  assert.equal(breaks,1);assert.equal(remaining,3);
  assert.deepEqual(advanceCombo(1,1),{remaining:3,broken:false},'a clear on the last chance is on time');
  assert.deepEqual(advanceCombo(1,0),{remaining:3,broken:true});
  assert.deepEqual(advanceCombo(2,3),{remaining:3,broken:false},'several lines consume one placement');
});

test('default three-chance policy finds a clear, two chances can be preserved, and one chance can be impossible',()=>{
  for(const remaining of [1,2,3]) {
    const result=solveStrategicBoard(twoGaps,dots,{comboRemaining:remaining,timeBudgetMs:0});
    assert.equal(result.placedCount,3);
    assert.equal(result.combo.breaks,remaining===1?1:0);
    const first=result.moves.findIndex(move=>move.clearedRows.length+move.clearedCols.length>0);
    assert(first>=0);
    if(remaining>1)assert(first+1<=remaining);
  }
  const empty=solveStrategicBoard(Array(8).fill(0),dots,{timeBudgetMs:0});
  assert.equal(empty.placedCount,3,'an impossible clear must not turn a valid full placement into failure');
  assert.equal(empty.combo.breaks,1);
  assert.equal(empty.clearedLines,0);
  for(const remaining of [null,'',undefined]) {
    const result=solveStrategicBoard(twoGaps,dots,{comboRemaining:remaining,timeBudgetMs:0});
    assert.equal(result.combo.initialRemaining,3);assert.equal(result.combo.breaks,0);
  }
});

test('search retains identical final boards with different remaining combo windows',()=>{
  const found=new Set(),target=[0,1,1,0,0,0,0,0];
  solveBoard([127,0,0,0,0,0,0,0],dots,{comboRemaining:3,onCandidate:candidate=>{
    if(candidate.placedCount===3&&candidate.combo.breaks===0&&candidate.board.every((row,r)=>row===target[r]))found.add(candidate.combo.remaining);
  }});
  assert.deepEqual([...found].sort(),[1,2,3]);
});

test('the remaining combo window carries across tray boundaries',()=>{
  const first=solveStrategicBoard(Array(8).fill(0),dots.slice(0,2),{comboRemaining:3,timeBudgetMs:0});
  assert.equal(first.combo.remaining,1);assert.equal(first.combo.breaks,0);
  const next=solveStrategicBoard(first.finalBoard,[[[1]]],{comboRemaining:first.combo.remaining,timeBudgetMs:0});
  assert.equal(next.combo.breaks,1);
  const fresh=solveStrategicBoard(first.finalBoard,[[[1]]],{comboRemaining:3,timeBudgetMs:0});
  assert.equal(fresh.combo.breaks,0,'blindly resetting to 3 would miss a broken combo');
});

// Independent cell-matrix enumeration uses non-clearing counts instead of the
// production countdown implementation, and compares feasibility + lost windows.
function reference(rows,shapes,chance) {
  let placed=-1,broken=Infinity;
  function walk(board,remaining,misses,lost,count) {
    if(count>placed||(count===placed&&lost<broken)){placed=count;broken=lost;}
    remaining.forEach((shape,index)=>{
      const cells=shape.flatMap((row,r)=>row.flatMap((value,c)=>value?[[r,c]]:[]));
      for(let r=0;r<8;r++)for(let c=0;c<8;c++){
        if(cells.some(([rr,cc])=>r+rr>=8||c+cc>=8||board[r+rr][c+cc]))continue;
        const next=board.map(row=>row.slice());cells.forEach(([rr,cc])=>{next[r+rr][c+cc]=true;});
        const fullRows=next.map(row=>row.every(Boolean)),fullCols=Array.from({length:8},(_,cc)=>next.every(row=>row[cc]));
        const clear=fullRows.some(Boolean)||fullCols.some(Boolean);
        next.forEach((row,rr)=>row.forEach((_,cc)=>{if(fullRows[rr]||fullCols[cc])next[rr][cc]=false;}));
        let nextMiss=clear?0:misses+1,nextLost=lost;
        if(nextMiss===3){nextLost++;nextMiss=0;}
        walk(next,remaining.filter((_,i)=>i!==index),nextMiss,nextLost,count+1);
      }
    });
  }
  walk(rows.map(bits=>Array.from({length:8},(_,c)=>Boolean(bits&(1<<c)))),shapes,3-chance,0,0);
  return {placed,broken};
}

test('combo-aware exact search matches independent enumeration including partial trays',()=>{
  const cases=[{board:twoGaps,pieces:dots},
    {board:[113,104,4,45,30,135,120,3],pieces:[[[1,1]],[[1,0],[1,1]],[[1],[1],[1]]]},
    {board:[170,85,170,85,170,85,170,85],pieces:[[[1]],[[1,1],[1,1]],[[1],[1]]]}];
  for(const item of cases)for(const chance of [1,2,3]){
    const expected=reference(item.board,item.pieces,chance);
    const result=solveBoard(item.board,item.pieces,{comboRemaining:chance});
    assert.equal(result.placedCount,expected.placed);assert.equal(result.combo.breaks,expected.broken);
  }
});
