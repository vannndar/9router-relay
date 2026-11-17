import { normalizePiece, canPlace, solveBoard, normalizeComboRemaining, advanceCombo } from './solver-core.mjs';

const POP = Uint8Array.from({ length: 256 }, (_, bits) => bits.toString(2).replaceAll('0', '').length);
const boardKey = board => String.fromCharCode(...board);
const placed = piece => {
  const positions = [];
  for (let row = 0; row <= 8 - piece.height; row++) for (let col = 0; col <= 8 - piece.width; col++) {
    positions.push({ row, col, masks: piece.rows.map(bits => bits << col) });
  }
  return positions;
};

function rotate(matrix) {
  return Array.from({ length: matrix[0].length }, (_, r) => matrix.map(row => row[r]).reverse());
}
function family(seed, mirror = false) {
  const shapes = new Map();
  for (const base of mirror ? [seed, seed.map(row => row.slice().reverse())] : [seed]) {
    let matrix = base;
    for (let turn = 0; turn < 4; turn++) {
      const piece = normalizePiece(matrix);
      if (!shapes.has(piece.signature)) shapes.set(piece.signature, { ...piece, positions: placed(piece) });
      matrix = rotate(matrix);
    }
  }
  return [...shapes.values()];
}

// A simulation model, not a claim about Hungry Studio's hidden piece generator.
// Orientations are distinct future offers; the current tray is never rotated.
const families = [
  ...Array.from({ length: 5 }, (_, i) => family([Array(i + 1).fill(1)])),
  family([[1,1],[1,1]]), family([[1,1,1],[1,1,1],[1,1,1]]),
  family([[1,1,1],[1,1,1]]), family([[1,0],[1,1]]),
  family([[1,0],[1,0],[1,1]], true), family([[1,1,1],[0,1,0]]),
  family([[0,1,1],[1,1,0]], true), family([[1,0,0],[1,0,0],[1,1,1]]),
  family([[1,0],[0,1]], true), family([[1,0,0],[0,1,0],[0,0,1]], true),
];
export const futureCatalog = families.flat();
const large = futureCatalog.filter(piece => piece.cells >= 5);
const irregular = futureCatalog.filter(piece => piece.cells >= 3 && piece.cells < piece.width * piece.height);

// This inexpensive evaluation is used while enumerating many placements.
// It balances quantities rather than letting one extra shape fit override every
// other board property, as the previous lexicographic ordering did.
export function evaluatePosition(board) {
  const empty = board.map(row => row ^ 255);
  let free = 0, isolated = 0, adjacency = 0, pressure = 0;
  let squares = 0, rectangles = 0, lines = 0;
  for (let r = 0; r < 8; r++) {
    const bits = empty[r], above = empty[r - 1] || 0, below = empty[r + 1] || 0;
    free += POP[bits];
    isolated += POP[bits & ~((bits << 1) | (bits >> 1) | above | below) & 255];
    adjacency += POP[bits & (bits >> 1)] + POP[bits & below];
    const occupied = POP[board[r]];
    if (occupied >= 5) pressure += (occupied - 4) ** 2;
    let column = 0;
    for (let rr = 0; rr < 8; rr++) column += (board[rr] >> r) & 1;
    if (column >= 5) pressure += (column - 4) ** 2;
    lines += POP[bits & (bits >> 1) & (bits >> 2) & (bits >> 3) & (bits >> 4)];
    if (r < 4) lines += POP[bits & empty[r + 1] & empty[r + 2] & empty[r + 3] & empty[r + 4]];
    if (r < 6) {
      const shared = bits & empty[r + 1] & empty[r + 2];
      squares += POP[shared & (shared >> 1) & (shared >> 2)];
      rectangles += POP[shared & (shared >> 1)];
    }
    if (r < 7) {
      const shared = bits & below;
      rectangles += POP[shared & (shared >> 1) & (shared >> 2)];
    }
  }
  return free * 2.4 + adjacency * .42 - isolated * 23 + pressure * .45 +
    Math.log1p(squares) * 13 + Math.log1p(rectangles) * 8 + Math.log1p(lines) * 8 -
    (squares ? 0 : 15) - (lines ? 0 : 8);
}

function detailedQuality(board) {
  let score = evaluatePosition(board), coverage = 0, mobility = 0;
  for (const piece of futureCatalog) {
    let count = 0;
    for (const position of piece.positions) if (canPlace(board, piece, position.row, position.col)) count++;
    coverage += Number(count > 0); mobility += Math.log1p(count);
  }
  score += coverage * 1.1 + mobility * .55;
  const visited = Array(8).fill(0);
  let largest = 0, small = 0;
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    if ((board[r] | visited[r]) & (1 << c)) continue;
    const queue = [r * 8 + c]; visited[r] |= 1 << c;
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i], rr = at >> 3, cc = at & 7;
      for (const next of [cc ? at - 1 : -1, cc < 7 ? at + 1 : -1, rr ? at - 8 : -1, rr < 7 ? at + 8 : -1]) {
        if (next < 0) continue;
        const nr = next >> 3, nc = next & 7;
        if ((board[nr] | visited[nr]) & (1 << nc)) continue;
        visited[nr] |= 1 << nc; queue.push(next);
      }
    }
    largest = Math.max(largest, queue.length);
    if (queue.length <= 4) small += queue.length;
  }
  return score + largest * .45 - small * 7;
}

function insertBest(list, candidate, limit) {
  if (list.length === limit && candidate.score <= list.at(-1).score) return;
  let index = 0;
  while (index < list.length && list[index].score >= candidate.score) index++;
  list.splice(index, 0, candidate);
  if (list.length > limit) list.pop();
}

function compactPlacement(board, piece, position) {
  for (let r = 0; r < piece.height; r++) if (board[position.row + r] & position.masks[r]) return null;
  const next = board.slice();
  for (let r = 0; r < piece.height; r++) next[position.row + r] |= position.masks[r];
  let columns = 255, fullRows = 0, cleared = 0;
  for (let r = 0; r < 8; r++) {
    columns &= next[r];
    if (next[r] === 255) { fullRows |= 1 << r; cleared++; }
  }
  cleared += POP[columns];
  if (fullRows || columns) for (let r = 0; r < 8; r++) next[r] = fullRows & (1 << r) ? 0 : next[r] & (columns ^ 255);
  return { board: next, cleared };
}

function prepareHand(matrices) {
  return matrices.map(matrix => {
    const piece = normalizePiece(matrix);
    return { ...piece, positions: placed(piece) };
  });
}

// Future decisions see only the simulated hand currently dealt. They cannot
// exploit later hands before those hands become visible to the simulated player.
function clearBeforeDeadlinePossible(board, pieces, remaining) {
  if (remaining > pieces.length) return false;
  const capacity = values => values.sort((a,b) => b-a).slice(0,remaining).reduce((sum,n) => sum+n,0);
  const rowCapacity = capacity(pieces.map(piece => Math.max(...piece.rows.map(bits => POP[bits]))));
  const colCapacity = capacity(pieces.map(piece => Math.max(...Array.from({length:piece.width},(_,c) =>
    piece.rows.reduce((sum,row) => sum + ((row >> c) & 1),0)))));
  let rowGap = 8, colGap = 8;
  for (let r = 0; r < 8; r++) {
    rowGap = Math.min(rowGap,8-POP[board[r]]);
    let occupied = 0;
    for (let rr = 0; rr < 8; rr++) occupied += (board[rr] >> r) & 1;
    colGap = Math.min(colGap,8-occupied);
  }
  // Optimistic per-line capacities can disprove a clear, never prove one.
  return rowCapacity >= rowGap || colCapacity >= colGap;
}
function playHand(board, pieces, width, counters, initialRemaining) {
  let frontier = [{ board, used: 0, placedCount: 0, cleared: 0, remaining: initialRemaining, breaks: 0, score: evaluatePosition(board) }];
  let best = frontier[0];
  for (let depth = 0; depth < pieces.length; depth++) {
    const bins = new Map(), seen = new Map();
    for (const entry of frontier) {
      const duplicates = new Set();
      for (let i = 0; i < pieces.length; i++) {
        const piece = pieces[i];
        if (entry.used & (1 << i) || duplicates.has(piece.signature)) continue;
        duplicates.add(piece.signature);
        const used = entry.used | (1 << i);
        for (const position of piece.positions) {
          const next = compactPlacement(entry.board, piece, position);
          if (!next) continue;
          counters.simulationPositions++;
          const cleared = entry.cleared + next.cleared;
          const combo = advanceCombo(entry.remaining,next.cleared), breaks = entry.breaks + Number(combo.broken);
          const key = boardKey(next.board) + String.fromCharCode(used,combo.remaining);
          const previous = seen.get(key);
          if (previous && (previous.breaks < breaks || (previous.breaks === breaks && previous.cleared >= cleared))) continue;
          seen.set(key, { breaks, cleared });
          const binKey = used | (combo.remaining << 3) | (breaks << 5);
          let bin = bins.get(binKey);
          if (!bin) { bin = []; bins.set(binKey,bin); }
          const candidate = { board: next.board, used, placedCount: depth + 1, cleared, remaining: combo.remaining, breaks,
            score: evaluatePosition(next.board) + cleared * 7 + combo.remaining * 2 };
          insertBest(bin, candidate, width);
        }
      }
    }
    frontier = [...bins.values()].flat();
    if (!frontier.length) break;
    best = frontier.reduce((a,b) => b.breaks < a.breaks || (b.breaks === a.breaks && b.score > a.score) ? b : a);
  }
  if (best.placedCount < pieces.length || (best.breaks > 0 && clearBeforeDeadlinePossible(board,pieces,initialRemaining))) {
    // A narrow beam may miss a rescue. Prove current-hand feasibility with the
    // exact search before counting this simulated hand as a failure.
    const rescue = solveBoard(board,pieces.map(piece => piece.matrix),{
      evaluateBoard: state => [evaluatePosition(state)],comboRemaining:initialRemaining });
    counters.feasibilityRescues++;
    return { board: rescue.finalBoard, placedCount: rescue.placedCount, cleared: rescue.clearedLines,
      remaining:rescue.combo.remaining,breaks:rescue.combo.breaks };
  }
  return best;
}

function seedFor(board, pieces) {
  let seed = 2166136261;
  const values = [...board];
  pieces.forEach((matrix, index) => {
    const piece = matrix ? normalizePiece(matrix) : null;
    values.push(17 + index, ...(piece ? [piece.width, piece.height, ...piece.rows] : [0]));
  });
  for (const value of values) {
    seed = Math.imul(seed ^ value, 16777619) >>> 0;
  }
  return seed || 1;
}
function scenariosFor(seed, count, horizon) {
  let state = seed;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const pick = list => list[Math.floor(random() * list.length)];
  return Array.from({ length: count }, (_, index) => Array.from({ length: horizon }, () => {
    // Family-balanced draws plus separate large/irregular pressure scenarios.
    // No board-dependent filtering: difficult offers remain difficult offers.
    const hand = Array.from({ length: 3 }, () => pick(pick(families)));
    if (index % 5 === 1) { hand[0] = pick(large); hand[1] = pick(large); }
    if (index % 5 === 3) { hand[0] = pick(irregular); hand[1] = pick(irregular); }
    return hand;
  }));
}

function distance(a, b) {
  let count = 0;
  for (let r = 0; r < 8; r++) count += POP[a[r] ^ b[r]];
  return count;
}
function selectDiverse(pool, limit) {
  const sorted = pool.map(entry => ({ ...entry, score: detailedQuality(entry.board) + entry.clearedLines * 2 + entry.combo.remaining * 2 })).sort((a, b) => b.score - a.score);
  const selected = [sorted.shift()];
  while (sorted.length && selected.length < limit) {
    let at = 0, best = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const diversity = Math.min(...selected.map(candidate => distance(candidate.board, sorted[i].board)));
      const score = sorted[i].score + diversity * 1.8;
      if (score > best) { best = score; at = i; }
    }
    selected.push(sorted.splice(at, 1)[0]);
  }
  return selected;
}

function rollOut(board, scenario, width, counters, initialRemaining) {
  let state = board, completed = 0, piecesPlaced = 0, cleared = 0, remaining = initialRemaining, breaks = 0;
  for (const hand of scenario) {
    const next = playHand(state,hand,width,counters,remaining);
    piecesPlaced += next.placedCount; cleared += next.cleared; state = next.board;
    remaining = next.remaining; breaks += next.breaks;
    if (next.placedCount < hand.length) break;
    completed++;
  }
  return completed * 1200 + piecesPlaced * 35 + cleared * 12 - breaks * 140 + remaining * 3 + evaluatePosition(state) * .25;
}
function robustScore(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  const mean = ordered.reduce((sum, value) => sum + value, 0) / ordered.length;
  const tail = ordered.slice(0, Math.max(1, Math.ceil(ordered.length * .25)));
  return mean * .65 + tail.reduce((sum, value) => sum + value, 0) / tail.length * .35;
}

export function solveStrategicBoard(inputBoard, inputPieces, {
  onProgress, timeBudgetMs = 2600, candidateLimit = 8, scenarioCount = 20,
  horizon = 3, beamWidth = 3, scenarios: suppliedScenarios, comboRemaining = 3,
} = {}) {
  const start = performance.now(), pool = [], representatives = new Map();
  const initialRemaining = normalizeComboRemaining(comboRemaining);
  let maxPlaced = -1, minimumBreaks = Infinity;
  function collect(candidate) {
    if (candidate.placedCount < maxPlaced) return;
    if (candidate.placedCount > maxPlaced) { maxPlaced = candidate.placedCount; minimumBreaks = Infinity; pool.length = 0; representatives.clear(); }
    if (candidate.combo.breaks > minimumBreaks) return;
    if (candidate.combo.breaks < minimumBreaks) { minimumBreaks = candidate.combo.breaks; pool.length = 0; representatives.clear(); }
    const score = candidate.quality[0] + candidate.clearedLines * 2 + candidate.combo.remaining * 2;
    const quadrants = [0, 0, 0, 0];
    candidate.board.forEach((bits, r) => {
      quadrants[r < 4 ? 0 : 2] += POP[bits & 15]; quadrants[r < 4 ? 1 : 3] += POP[bits >> 4];
    });
    const bucket = quadrants.map(value => Math.floor(value / 5)).join('') + ':' + candidate.combo.remaining;
    const representative = representatives.get(bucket);
    const needsPool = pool.length < 80 || score > pool.at(-1).score;
    const needsBucket = !representative || score > representative.score;
    if (!needsPool && !needsBucket) return;
    const snapshot = { board: candidate.board, moves: candidate.moves.slice(), placedCount: candidate.placedCount,
      clearedLines: candidate.clearedLines, score, combo:candidate.combo };
    if (needsPool) insertBest(pool, snapshot, 80);
    if (needsBucket) representatives.set(bucket, snapshot);
  }
  const initial = solveBoard(inputBoard, inputPieces, {
    evaluateBoard: board => [evaluatePosition(board)], onCandidate: collect, comboRemaining:initialRemaining,
    onProgress: progress => onProgress?.({ ...progress, phase: 'search' }),
  });
  const counters = { simulationPositions: 0, feasibilityRescues: 0 };
  // Unplaced current pieces prevent the next tray from being dealt. Never invent
  // future hands after an unsolvable current tray.
  if (initial.placedCount !== initial.totalPieces || timeBudgetMs <= 0) {
    return { ...initial, stats: { ...initial.stats, ...counters, scenariosCompleted: 0, candidatesCompared: 0, elapsedMs: Math.round(performance.now() - start) } };
  }
  const merged = new Map();
  for (const candidate of [...pool, ...representatives.values()]) {
    const key = boardKey(candidate.board) + String.fromCharCode(candidate.combo.remaining), existing = merged.get(key);
    if (!existing || candidate.score > existing.score) merged.set(key, candidate);
  }
  const candidates = selectDiverse([...merged.values()], Math.max(1, candidateLimit));
  const scenarios = suppliedScenarios ? suppliedScenarios.map(scenario => scenario.map(prepareHand)) :
    scenariosFor(seedFor(inputBoard, inputPieces), Math.max(1, scenarioCount), Math.max(1, horizon));
  const measurements = candidates.map(() => []);
  const deadline = performance.now() + timeBudgetMs;
  let rounds = 0;
  for (const scenario of scenarios) {
    if (performance.now() >= deadline) break;
    const round = [];
    for (const candidate of candidates) {
      if (performance.now() >= deadline) break;
      round.push(rollOut(candidate.board,scenario,beamWidth,counters,candidate.combo.remaining));
    }
    // Incomplete comparison rounds are discarded: every candidate must have
    // faced precisely the same scenarios before it can outrank another.
    if (round.length !== candidates.length) break;
    round.forEach((value, index) => measurements[index].push(value)); rounds++;
    onProgress?.({ phase: 'lookahead', visited: counters.simulationPositions, elapsedMs: performance.now() - start });
  }
  let best = candidates[0], bestScore = -Infinity;
  candidates.forEach((candidate, index) => {
    const score = (rounds ? robustScore(measurements[index]) : 0) + candidate.score * .08;
    if (score > bestScore) { bestScore = score; best = candidate; }
  });
  return { ...initial, moves: best.moves, finalBoard: best.board, clearedLines: best.clearedLines, combo:best.combo,
    remainingIndices: [], rank: [best.placedCount, bestScore],
    stats: { ...initial.stats, ...counters, scenariosCompleted: rounds,
      candidatesCompared: candidates.length, elapsedMs: Math.round(performance.now() - start) } };
}
