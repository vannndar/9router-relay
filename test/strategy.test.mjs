import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { normalizePiece, applyPlacement, solveBoard } from '../web/solver-core.mjs';
import { solveStrategicBoard, futureCatalog } from '../web/solver-strategy.mjs';

const current = [[[1,1]], [[1,0],[1,1]], [[1],[1],[1]]];
const difficult = [[[1,1,1],[1,1,1],[1,1,1]], [[1,1,1],[1,1,1]], [[1,1,1,1,1]]];
const witness = [113,104,4,45,30,135,120,3];

function checkReplay(board, pieces, result) {
  let state = board.slice();
  const used = new Set();
  let lines = 0;
  for (const move of result.moves) {
    assert(!used.has(move.pieceIndex)); used.add(move.pieceIndex);
    const next = applyPlacement(state, normalizePiece(pieces[move.pieceIndex]), move.row, move.col);
    assert(next, 'every returned placement must fit its fixed-orientation piece');
    assert.deepEqual(next.board, move.board); state = next.board;
    lines += next.clearedRows.length + next.clearedCols.length;
  }
  assert.deepEqual(result.finalBoard, state); assert.equal(lines, result.clearedLines);
  assert.equal(used.size, result.placedCount);
}

test('lookahead changes a current-tray solution to preserve a complete difficult next tray', () => {
  const baseline = solveBoard(witness, current);
  assert.equal(solveBoard(baseline.finalBoard, difficult).placedCount, 2);
  const planned = solveStrategicBoard(witness, current, { scenarios: [[difficult]], candidateLimit: 12, timeBudgetMs: Infinity });
  assert.equal(planned.placedCount, 3);
  assert.equal(solveBoard(planned.finalBoard, difficult).placedCount, 3);
  assert.equal(planned.stats.scenariosCompleted, 1);
  assert.equal(planned.stats.candidatesCompared, 12);
  checkReplay(witness, current, planned);
});

test('strategic search preserves exact current-tray feasibility, original slots and partial-result semantics', () => {
  const cases = [
    { board: witness, pieces: current },
    { board: [0,0,254,170,85,170,85,170], pieces: [difficult[0],null,[[1]]] },
    { board: [170,85,170,85,170,85,170,85], pieces: [[[1,1],[1,1]], [[1,1]], null] },
    { board: Array(8).fill(0), pieces: [[[1],[1],[1],[1],[1]]] },
  ];
  for (const item of cases) {
    const original = structuredClone(item);
    const baseline = solveBoard(item.board, item.pieces);
    const result = solveStrategicBoard(item.board, item.pieces, { scenarioCount: 4, horizon: 2, timeBudgetMs: Infinity });
    assert.equal(result.placedCount, baseline.placedCount);
    checkReplay(item.board, item.pieces, result); assert.deepEqual(item, original);
    if (result.placedCount < result.totalPieces) {
      assert.equal(result.stats.scenariosCompleted, 0, 'the next tray cannot arrive before the current tray is completed');
      assert.equal(result.stats.simulationPositions, 0);
    }
  }
});

test('simulation is reproducible and balances the same completed scenarios across all candidates', () => {
  const options = { scenarioCount: 8, horizon: 3, timeBudgetMs: Infinity };
  const a = solveStrategicBoard(witness, current, options);
  const b = solveStrategicBoard(witness, current, options);
  assert.deepEqual(a.moves, b.moves); assert.deepEqual(a.rank, b.rank);
  assert.equal(a.stats.scenariosCompleted, 8); assert(a.stats.simulationPositions > 0);
  const padded = current.map(matrix => {
    const result = Array.from({ length: 5 }, () => Array(5).fill(0));
    matrix.forEach((row,r) => row.forEach((value,c) => { result[r+1][c+1] = value; })); return result;
  });
  const c = solveStrategicBoard(witness, padded, options);
  assert.deepEqual(a.moves, c.moves, 'equivalent editor padding must not change the future sample stream');
  const noBudget = solveStrategicBoard(witness, current, { timeBudgetMs: 0 });
  assert.equal(noBudget.stats.scenariosCompleted, 0); checkReplay(witness, current, noBudget);
});

test('simulation catalogue contains unique orientations and produces legal full-tray plans', () => {
  assert.equal(new Set(futureCatalog.map(piece => piece.signature)).size, futureCatalog.length);
  assert(futureCatalog.some(piece => piece.width === 5 && piece.height === 1));
  assert(futureCatalog.some(piece => piece.width === 1 && piece.height === 5));
  assert(futureCatalog.some(piece => piece.width === 3 && piece.height === 3 && piece.cells === 9));
  for (const piece of futureCatalog) assert.equal(normalizePiece(piece.matrix).signature, piece.signature);
});

test('the deployed worker entry runs strategic search and serializes progress, final results and input errors', async () => {
  const entry = new URL('../web/solver-worker.mjs', import.meta.url).href;
  const code = `import { parentPort } from 'node:worker_threads';
    globalThis.self={postMessage: message=>parentPort.postMessage(message)};
    await import(${JSON.stringify(entry)});
    parentPort.on('message',data=>self.onmessage({data}));
    parentPort.postMessage({type:'ready'});`;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(code)}`));
  try {
    const result = await new Promise((resolve,reject) => {
      worker.once('error',reject);
      worker.on('message', message => {
        if (message.type === 'ready') worker.postMessage({ board:witness,pieces:current,comboRemaining:1 });
        if (message.type === 'result') resolve(message.result);
        if (message.type === 'error') reject(new Error(message.message));
      });
    });
    assert.equal(result.placedCount,3); assert(result.stats.scenariosCompleted>0);
    assert.equal(result.combo.initialRemaining,1);
    checkReplay(witness,current,result);
    const failure = await new Promise(resolve => {
      worker.once('message',resolve); worker.postMessage({board:[],pieces:current});
    });
    assert.equal(failure.type,'error'); assert.match(failure.message,/8 baris/);
  } finally { await worker.terminate(); }
});
