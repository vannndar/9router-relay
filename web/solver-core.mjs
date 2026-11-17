// The board uses eight unsigned 8-bit row masks. JS 32-bit bitwise operations
// are safe here: we never pack all 64 cells into a Number.
const BITS = Uint8Array.from({ length: 256 }, (_, n) => n.toString(2).replaceAll('0', '').length);

export function normalizeComboRemaining(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return 3;
  const remaining = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(remaining) || remaining < 1 || remaining > 3) throw new Error('Sisa kesempatan combo harus 1, 2, atau 3.');
  return remaining;
}

export function advanceCombo(remaining, clearedLines) {
  return { remaining: clearedLines > 0 || remaining === 1 ? 3 : remaining - 1,
    broken: clearedLines === 0 && remaining === 1 };
}

export function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== 8 || board.some(row => !Number.isInteger(row) || row < 0 || row > 255)) {
    throw new Error('Papan harus berisi 8 baris dengan 8 sel.');
  }
  return board.slice();
}

export function normalizePiece(matrix) {
  if (!Array.isArray(matrix) || !matrix.length || matrix.length > 5 ||
      matrix.some(row => !Array.isArray(row) || row.length > 5 || row.some(value => ![0, 1, false, true].includes(value)))) {
    throw new Error('Bentuk balok harus berupa kisi maksimal 5 × 5.');
  }
  const cells = [];
  matrix.forEach((row, r) => row.forEach((value, c) => { if (value) cells.push([r, c]); }));
  if (!cells.length) throw new Error('Gambar sedikitnya satu sel pada balok.');
  const top = Math.min(...cells.map(cell => cell[0]));
  const left = Math.min(...cells.map(cell => cell[1]));
  const height = Math.max(...cells.map(cell => cell[0])) - top + 1;
  const width = Math.max(...cells.map(cell => cell[1])) - left + 1;
  const rows = Array(height).fill(0);
  cells.forEach(([r, c]) => { rows[r - top] |= 1 << (c - left); });
  return { rows, width, height, cells: cells.length, signature: `${width}:${rows.join(',')}`,
    matrix: rows.map(row => Array.from({ length: width }, (_, c) => Number(Boolean(row & (1 << c))))) };
}

export function canPlace(board, piece, row, col) {
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row + piece.height > 8 || col + piece.width > 8) return false;
  for (let r = 0; r < piece.height; r++) if (board[row + r] & (piece.rows[r] << col)) return false;
  return true;
}

export function applyPlacement(board, piece, row, col) {
  if (!canPlace(board, piece, row, col)) return null;
  const next = board.slice();
  piece.rows.forEach((bits, r) => { next[row + r] |= bits << col; });
  const clearedRows = [];
  let columnMask = 255;
  // Find BOTH sets before removing anything: intersections clear simultaneously.
  next.forEach((bits, r) => { if (bits === 255) clearedRows.push(r); columnMask &= bits; });
  const clearedCols = Array.from({ length: 8 }, (_, c) => c).filter(c => columnMask & (1 << c));
  const rowSet = new Set(clearedRows);
  for (let r = 0; r < 8; r++) next[r] = rowSet.has(r) ? 0 : next[r] & (~columnMask & 255);
  return { board: next, clearedRows, clearedCols };
}

const probeMatrices = [
  [[1,1,1],[1,1,1],[1,1,1]], [[1,1],[1,1]],
  [[1,1,1],[1,1,1]], [[1,1],[1,1],[1,1]],
  [[1,1,1,1,1]], [[1],[1],[1],[1],[1]],
];
const probes = probeMatrices.map(normalizePiece);

function roomQuality(board) {
  let coverage = 0, mobility = 0, isolated = 0, empty = 0;
  for (const piece of probes) {
    let count = 0;
    for (let r = 0; r <= 8 - piece.height; r++) for (let c = 0; c <= 8 - piece.width; c++) {
      if (canPlace(board, piece, r, c)) count++;
    }
    coverage += Number(count > 0); mobility += count;
  }
  for (let r = 0; r < 8; r++) {
    empty += 8 - BITS[board[r]];
    for (let c = 0; c < 8; c++) {
      if (board[r] & (1 << c)) continue;
      if ((r === 0 || board[r - 1] & (1 << c)) && (r === 7 || board[r + 1] & (1 << c)) &&
          (c === 0 || board[r] & (1 << (c - 1))) && (c === 7 || board[r] & (1 << (c + 1)))) isolated++;
    }
  }
  return [coverage, -isolated, mobility, empty];
}

function better(a, b) {
  if (!b) return true;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

export function solveBoard(inputBoard, inputPieces, { onProgress, evaluateBoard = roomQuality, onCandidate, comboRemaining } = {}) {
  const board = validateBoard(inputBoard);
  if (!Array.isArray(inputPieces) || inputPieces.length > 3) throw new Error('Masukkan 1 sampai 3 balok.');
  const pieces = inputPieces.map((matrix, index) => matrix ? { ...normalizePiece(matrix), index } : null).filter(Boolean);
  if (!pieces.length) throw new Error('Gambar sedikitnya satu balok terlebih dahulu.');
  let columns = 255;
  board.forEach(row => { columns &= row; });
  if (board.includes(255) || columns) throw new Error('Ada garis yang sudah penuh. Periksa kembali papan sebelum menghitung.');
  const start = performance.now();
  const comboEnabled = comboRemaining !== undefined;
  const initialRemaining = comboEnabled ? normalizeComboRemaining(comboRemaining) : 3;
  const seen = new Map(), qualities = new Map();
  let best = null, rank = null, bestCombo = null, visited = 0;
  function search(state, used, moves, cleared, remaining, breaks) {
    visited++;
    if ((visited & 8191) === 0) onProgress?.({ visited, elapsedMs: performance.now() - start });
    const key = comboEnabled ? String.fromCharCode(...state, used, remaining) : String.fromCharCode(...state, used);
    const previous = seen.get(key);
    if (comboEnabled) {
      if (previous && (previous.breaks < breaks || (previous.breaks === breaks && previous.cleared >= cleared))) return;
      seen.set(key, { breaks, cleared });
    } else {
      if ((previous ?? -1) >= cleared) return;
      seen.set(key, cleared);
    }
    let advanced = false;
    const duplicateShapes = new Set();
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (used & (1 << i) || duplicateShapes.has(piece.signature)) continue;
      duplicateShapes.add(piece.signature);
      for (let r = 0; r <= 8 - piece.height; r++) for (let c = 0; c <= 8 - piece.width; c++) {
        const next = applyPlacement(state, piece, r, c);
        if (!next) continue;
        advanced = true;
        const lines = next.clearedRows.length + next.clearedCols.length;
        const combo = comboEnabled ? advanceCombo(remaining, lines) : { remaining, broken: false };
        moves.push({ pieceIndex: piece.index, row: r, col: c, ...next, ...(comboEnabled ? { comboRemaining: combo.remaining } : {}) });
        search(next.board, used | (1 << i), moves, cleared + lines, combo.remaining, breaks + Number(combo.broken));
        moves.pop();
      }
    }
    if (!advanced) {
      if (rank && moves.length < rank[0]) return;
      const boardKey = String.fromCharCode(...state);
      let quality = qualities.get(boardKey);
      if (!quality) { quality = evaluateBoard(state); qualities.set(boardKey, quality); }
      const combo = comboEnabled ? { initialRemaining, remaining, breaks } : undefined;
      const candidate = [moves.length, ...(comboEnabled ? [-breaks] : []), ...quality, cleared];
      // The path is borrowed during this callback. Collectors copy only paths
      // they retain, avoiding an allocation for every enumerated terminal state.
      onCandidate?.({ board: state, moves, placedCount: moves.length, clearedLines: cleared, rank: candidate, quality, combo });
      if (better(candidate, rank)) { rank = candidate; best = moves.slice(); bestCombo = combo; }
    }
  }
  search(board, 0, [], 0, initialRemaining, 0);
  const placed = new Set(best.map(move => move.pieceIndex));
  return { moves: best, initialBoard: board, totalPieces: pieces.length, placedCount: best.length,
    clearedLines: rank.at(-1), remainingIndices: pieces.map(piece => piece.index).filter(index => !placed.has(index)),
    finalBoard: best.at(-1)?.board || board, rank, ...(comboEnabled ? { combo: bestCombo } : {}),
    stats: { visited, uniqueStates: seen.size, elapsedMs: Math.round(performance.now() - start) } };
}
