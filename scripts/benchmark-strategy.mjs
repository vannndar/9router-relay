import assert from 'node:assert/strict';
import { normalizePiece, applyPlacement, solveBoard } from '../web/solver-core.mjs';
import { solveStrategicBoard, futureCatalog } from '../web/solver-strategy.mjs';

// Internal holdout check. Both policies receive the identical actual hand stream;
// neither policy is allowed to see the later hands from that stream.
const seeds = [23,71,199,241,613,991];
const large = futureCatalog.filter(piece=>piece.cells>=5);
const rows=[];
function handsFor(seed,regime) {
  let state=seed;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  const pick=list=>list[Math.floor(random()*list.length)].matrix;
  return Array.from({length:40},()=>Array.from({length:3},()=>pick(regime==='large'&&random()<.55?large:futureCatalog)));
}
function play(hands,solver) {
  let board=Array(8).fill(0),turns=0,cleared=0,comboRemaining=3;
  for(const pieces of hands) {
    const result=solver(board,pieces,{comboRemaining});
    comboRemaining=result.combo.remaining;
    const used=new Set();
    for(const move of result.moves) {
      assert(!used.has(move.pieceIndex));used.add(move.pieceIndex);
      const next=applyPlacement(board,normalizePiece(pieces[move.pieceIndex]),move.row,move.col);
      assert(next);assert.deepEqual(next.board,move.board);board=next.board;
    }
    cleared+=result.clearedLines;
    if(result.placedCount!==3)break;
    turns++;
  }
  return {turns,cleared};
}
for(let i=0;i<seeds.length;i++) {
  const regime=i%2?'large':'uniform',hands=handsFor(seeds[i],regime);
  const baseline=play(hands,solveBoard),strategic=play(hands,solveStrategicBoard);
  const row={seed:seeds[i],regime,baseline,strategic};rows.push(row);console.log(JSON.stringify(row));
}
console.log(JSON.stringify({summary:true,games:rows.length,
  baselineTurns:rows.reduce((n,row)=>n+row.baseline.turns,0),
  strategicTurns:rows.reduce((n,row)=>n+row.strategic.turns,0),
  note:'Finite synthetic holdout; not an official-game win-rate estimate.'}));
