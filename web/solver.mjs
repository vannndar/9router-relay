import { normalizePiece } from './solver-core.mjs';
import { detectScreenshot, readBoard, readPiece } from './solver-image.mjs';
import { enableGridPainting } from './grid-paint.mjs';

const oldRoom = new URLSearchParams(location.hash.slice(1)).get('r');
if (location.pathname === '/' && /^[A-Za-z0-9_-]{22}$/.test(oldRoom || '')) {
  // Fragments never reach the server. Preserve old room links on the client.
  location.replace(`/paste${location.hash}`);
} else boot();

function boot() {
  const $ = id => document.getElementById(id);
  const blank = () => Array.from({ length: 5 }, () => Array(5).fill(0));
  const colors = ['#facc15', '#3b82f6', '#a855f7'];
  let board = Array(8).fill(0), pieces = [blank(), blank(), blank()];
  let uncertain = [], worker = null, result = null, preview = 0;
  let imagePixels = null, boardRect = null, pieceRects = [], cropTarget = 'board', drag = null, imageGeneration = 0;
  const presets = {
    dot: [[1]], h2: [[1,1]], h3: [[1,1,1]], v3: [[1],[1],[1]], h4: [[1,1,1,1]], v4: [[1],[1],[1],[1]],
    h5: [[1,1,1,1,1]], v5: [[1],[1],[1],[1],[1]], square2: [[1,1],[1,1]], square3: [[1,1,1],[1,1,1],[1,1,1]],
    rect23: [[1,1,1],[1,1,1]], rect32: [[1,1],[1,1],[1,1]], corner: [[1,0],[1,1]],
    l: [[1,0],[1,0],[1,1]], t: [[1,1,1],[0,1,0]], s: [[0,1,1],[1,1,0]], z: [[1,1,0],[0,1,1]],
  };
  const presetNames = { dot: '1 sel', h2: 'Garis 2 horizontal', h3: 'Garis 3 horizontal', v3: 'Garis 3 vertikal', h4: 'Garis 4 horizontal', v4: 'Garis 4 vertikal', h5: 'Garis 5 horizontal', v5: 'Garis 5 vertikal', square2: 'Kotak 2 × 2', square3: 'Kotak 3 × 3', rect23: 'Persegi 2 × 3', rect32: 'Persegi 3 × 2', corner: 'Sudut kecil', l: 'Bentuk L', t: 'Bentuk T', s: 'Bentuk S', z: 'Bentuk Z' };

  function notice(id, message = '', error = false) {
    $(id).textContent = message; $(id).hidden = !message; $(id).classList.toggle('error', error);
  }
  function syncComboHint() {
    const hints = { 3:'Minimal satu pecahan dalam tiga penempatan.',2:'Pecah dalam dua penempatan berikutnya.',1:'Penempatan berikutnya harus pecah.' };
    $('comboHint').textContent = hints[$('comboChance').value] || hints[3];
  }
  function busy(value) { $('solveButton').disabled = value; $('cancelButton').hidden = !value; }
  function stop() { worker?.terminate(); worker = null; busy(false); }
  function invalidate(needsReview = true) {
    stop(); result = null; $('results').hidden = true; notice('solveNotice');
    if (needsReview) $('reviewedInput').checked = false;
  }
  $('comboChance').addEventListener('change', () => { invalidate(false); syncComboHint(); });
  function toEditor(matrix) {
    const editor = blank(); matrix?.forEach((row, r) => row.forEach((value, c) => { if (r < 5 && c < 5) editor[r][c] = Number(Boolean(value)); })); return editor;
  }
  function presentPieces() { return pieces.map(matrix => matrix.flat().some(Boolean) ? matrix : null); }
  function renderBoard() {
    [...$('board').children].forEach((cell, i) => {
      const r = Math.floor(i / 8), c = i % 8, filled = Boolean(board[r] & (1 << c));
      cell.className = `board-cell${filled ? ' filled' : ''}${uncertain.includes(i) ? ' uncertain' : ''}`;
      cell.setAttribute('aria-pressed', String(filled));
      cell.setAttribute('aria-label', `Baris ${r + 1}, kolom ${c + 1}: ${filled ? 'terisi' : 'kosong'}`);
    });
    const count = board.reduce((sum, row) => sum + row.toString(2).replaceAll('0', '').length, 0);
    $('filledCount').textContent = String(count); $('emptyCount').textContent = String(64 - count);
  }
  function renderPieces() {
    pieces.forEach((matrix, index) => {
      const grid = $(`pieceGrid${index}`);
      [...grid.children].forEach((cell, i) => {
        const r = Math.floor(i / 5), c = i % 5, filled = Boolean(matrix[r][c]);
        cell.classList.toggle('filled', filled); cell.setAttribute('aria-pressed', String(filled));
        cell.setAttribute('aria-label', `Balok ${index + 1}, baris ${r + 1}, kolom ${c + 1}: ${filled ? 'terisi' : 'kosong'}`);
      });
    });
  }
  function keyboardGrid(container, columns) {
    container.addEventListener('keydown', event => {
      const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
      if (offset === undefined) return;
      const cells = [...container.children], index = cells.indexOf(document.activeElement), next = index + offset;
      if (index < 0) return;
      event.preventDefault();
      if (next >= 0 && next < cells.length && (Math.abs(offset) !== 1 || Math.floor(next / columns) === Math.floor(index / columns))) cells[next].focus();
    });
  }
  for (let i = 0; i < 64; i++) {
    const cell = document.createElement('button'); cell.type = 'button';
    cell.dataset.cell = String(i);
    $('board').append(cell);
  }
  enableGridPainting($('board'), { columns: 8, rows: 8,
    read: index => Boolean(board[Math.floor(index / 8)] & (1 << (index % 8))),
    write: (index, filled) => {
      const row = Math.floor(index / 8), mask = 1 << (index % 8);
      board[row] = filled ? board[row] | mask : board[row] & ~mask;
      uncertain = uncertain.filter(value => value !== index);
    }, onChange: () => { invalidate(); renderBoard(); } });
  keyboardGrid($('board'), 8);
  pieces.forEach((_, index) => {
    const card = document.createElement('div'); card.className = `piece-card piece-${index}`;
    const heading = document.createElement('div'); heading.className = 'piece-card-heading';
    const label = document.createElement('span'); const dot = document.createElement('i'); dot.className = 'piece-dot'; label.append(dot, `Balok ${index + 1}`);
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Hapus'; clear.className = 'piece-clear'; clear.setAttribute('aria-label', `Kosongkan balok ${index + 1}`);
    clear.addEventListener('click', () => { invalidate(); pieces[index] = blank(); $(`preset${index}`).value = ''; renderPieces(); });
    heading.append(label, clear);
    const grid = document.createElement('div'); grid.id = `pieceGrid${index}`; grid.className = 'piece-grid'; grid.setAttribute('role', 'group'); grid.setAttribute('aria-label', `Editor bentuk balok ${index + 1}`);
    for (let i = 0; i < 25; i++) {
      const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'piece-cell';
      cell.dataset.cell = String(i);
      grid.append(cell);
    }
    enableGridPainting(grid, { columns: 5, rows: 5,
      read: cell => Boolean(pieces[index][Math.floor(cell / 5)][cell % 5]),
      write: (cell, filled) => { pieces[index][Math.floor(cell / 5)][cell % 5] = Number(filled); },
      onChange: () => { invalidate(); $(`preset${index}`).value = ''; renderPieces(); } });
    keyboardGrid(grid, 5);
    const select = document.createElement('select'); select.id = `preset${index}`; select.setAttribute('aria-label', `Pilih bentuk balok ${index + 1}`);
    select.append(new Option('Pilih bentuk…', ''));
    Object.entries(presetNames).forEach(([value, name]) => select.append(new Option(name, value)));
    select.addEventListener('change', () => { if (!select.value) return; invalidate(); pieces[index] = toEditor(presets[select.value]); renderPieces(); });
    card.append(heading, grid, select); $('pieceEditors').append(card);
  });

  $('clearBoard').addEventListener('click', () => { invalidate(); board = Array(8).fill(0); uncertain = []; renderBoard(); });
  $('manualButton').addEventListener('click', () => { $('board').firstElementChild.focus(); $('editorTitle').scrollIntoView?.({ behavior: 'smooth', block: 'start' }); });
  $('exampleButton').addEventListener('click', () => {
    invalidate();
    $('comboChance').value = '3'; syncComboHint();
    board = [119, 119, 0, 7, 7, 7, 0, 0];
    pieces = [toEditor([[1],[1]]), toEditor(presets.square3), toEditor(presets.corner)];
    uncertain = []; renderBoard(); renderPieces(); $('reviewedInput').checked = true;
    notice('solveNotice', 'Contoh siap. Cari urutan yang membuka ruang untuk semua balok.');
    $('editorTitle').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  });
  $('cancelButton').addEventListener('click', () => { stop(); notice('solveNotice', 'Pencarian dihentikan. Papanmu tetap tersedia.'); });
  $('solveButton').addEventListener('click', () => {
    invalidate(false);
    if (!$('reviewedInput').checked) { notice('solveNotice', 'Periksa papan dan bentuk balok, lalu centang konfirmasinya.', true); $('reviewedInput').focus(); return; }
    if (!presentPieces().some(Boolean)) { notice('solveNotice', 'Gambar atau pilih sedikitnya satu balok yang ingin dipasang.', true); return; }
    if (typeof Worker === 'undefined') { notice('solveNotice', 'Browser ini belum mendukung pencarian. Gunakan Safari, Chrome, atau Firefox terbaru.', true); return; }
    busy(true); notice('solveNotice', 'Mencari urutan penempatan terbaik…');
    try {
      const current = new Worker('/solver-worker.mjs', { type: 'module' }); worker = current;
      current.onmessage = ({ data }) => {
        if (worker !== current) return;
        if (data.type === 'progress') {
          notice('solveNotice', data.phase === 'lookahead' ? 'Menilai kelanjutan permainan…' : 'Mencari urutan penempatan terbaik…');
          return;
        }
        stop();
        if (data.type === 'error') { notice('solveNotice', data.message, true); return; }
        result = data.result; preview = 0; renderResults(); notice('solveNotice');
        $('results').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      };
      current.onerror = () => { if (worker === current) { stop(); notice('solveNotice', 'Pencarian belum berhasil dimuat. Muat ulang halaman dan coba lagi.', true); } };
      current.postMessage({ board: board.slice(), pieces: presentPieces(), comboRemaining:Number($('comboChance').value || 3) });
    } catch { stop(); notice('solveNotice', 'Pencarian belum bisa dimulai. Muat ulang halaman dan coba lagi.', true); }
  });

  function renderResults() {
    $('results').hidden = false;
    const complete = result.placedCount === result.totalPieces;
    $('resultTitle').textContent = result.placedCount ? 'Ikuti urutannya.' : 'Belum ada ruang yang cukup.';
    $('results').querySelector('.eyebrow').textContent = result.placedCount ? 'LANGKAHMU BERIKUTNYA' : 'PERIKSA KEMBALI PAPANNYA';
    $('resultBadge').textContent = `${result.placedCount} / ${result.totalPieces} balok terpasang`;
    $('resultSummary').textContent = result.placedCount === 0 ? 'Tidak ada balok yang muat pada papan ini. Periksa hasil pembacaan screenshot dan bentuk balok.' :
      `${complete ? 'Urutan terbaik yang ditemukan.' : 'Belum ada urutan untuk memasang semuanya. Ini urutan parsial terbaik.'} ${result.clearedLines} garis terhapus.${complete && result.combo?.breaks ? ' Batas combo tidak bisa dipenuhi sambil memasang semua balok.' : ''}`;
    $('moveList').replaceChildren();
    result.moves.forEach((move, index) => {
      const li = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.className = `piece-${move.pieceIndex}`;
      const step = document.createElement('span'); step.className = 'move-number'; step.textContent = String(index + 1);
      const detail = document.createElement('span'); detail.className = 'move-detail';
      const title = document.createElement('strong'); title.textContent = `Balok ${move.pieceIndex + 1}: baris ${move.row + 1}, kolom ${move.col + 1}`;
      const subtitle = document.createElement('small');
      const clears = [move.clearedRows.length ? `baris ${move.clearedRows.map(r => r + 1).join(', ')}` : '', move.clearedCols.length ? `kolom ${move.clearedCols.map(c => c + 1).join(', ')}` : ''].filter(Boolean);
      subtitle.textContent = `Posisi sudut kiri atas bentuk. ${clears.length ? `Hapus ${clears.join(' dan ')}.` : 'Belum ada garis terhapus.'}`;
      detail.append(title, subtitle);
      button.append(step, detail); button.addEventListener('click', () => { preview = index; renderPreview(); }); li.append(button); $('moveList').append(li);
    });
    $('useFinalBoard').hidden = !result.placedCount;
    $('resultStats').hidden = true;
    renderPreview();
  }
  function renderPreview() {
    if (!result) return;
    const move = result.moves[preview];
    const state = preview === 0 ? result.initialBoard : result.moves[preview - 1].board;
    const shape = move ? normalizePiece(pieces[move.pieceIndex]) : null;
    $('resultBoard').replaceChildren();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const cell = document.createElement('span');
      const next = move && r >= move.row && r < move.row + shape.height && c >= move.col && c < move.col + shape.width && shape.rows[r - move.row] & (1 << (c - move.col));
      cell.className = `board-cell${state[r] & (1 << c) ? ' filled' : ''}${next ? ` next piece-${move.pieceIndex}` : ''}`;
      if (next) cell.textContent = String(preview + 1);
      cell.setAttribute('aria-hidden', 'true'); $('resultBoard').append(cell);
    }
    $('resultBoard').setAttribute('aria-label', move ? `Langkah ${preview + 1}: letakkan balok ${move.pieceIndex + 1} di baris ${move.row + 1}, kolom ${move.col + 1}` : 'Papan setelah semua langkah rekomendasi');
    $('previewLabel').textContent = move ? `Langkah ${preview + 1} dari ${result.moves.length}` : 'Papan akhir';
    $('previousStep').disabled = preview === 0; $('nextStep').disabled = preview === result.moves.length;
    [...$('moveList').querySelectorAll('button')].forEach((button, index) => { if (index === preview) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
  }
  $('previousStep').addEventListener('click', () => { if (result && preview > 0) { preview--; renderPreview(); } });
  $('nextStep').addEventListener('click', () => { if (result && preview < result.moves.length) { preview++; renderPreview(); } });
  $('finalPreview').addEventListener('click', () => { if (result) { preview = result.moves.length; renderPreview(); } });
  $('useFinalBoard').addEventListener('click', () => {
    if (!result) return;
    $('comboChance').value = String(result.combo?.remaining || 3); syncComboHint();
    board = result.finalBoard.slice(); const used = new Set(result.moves.map(move => move.pieceIndex));
    pieces = pieces.map((matrix, index) => used.has(index) ? blank() : matrix); uncertain = [];
    invalidate(); renderBoard(); renderPieces();
    [...document.querySelectorAll('.piece-card select')].forEach(select => { select.value = ''; });
    notice('solveNotice', 'Papan akhir sudah diterapkan. Isi balok baru setelah giliran ini selesai.');
    $('editorTitle').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  });

  function drawScreenshot(temporaryRect) {
    if (!imagePixels) return;
    const context = $('imageCanvas').getContext('2d'); context.putImageData(imagePixels, 0, 0);
    const rectangles = [{ rect: boardRect, color: '#e5e5e5', label: 'Papan', target: 'board' }, ...pieceRects.map((rect, index) => ({ rect, color: colors[index], label: `Balok ${index + 1}`, target: String(index) }))];
    for (const item of rectangles) {
      const rect = temporaryRect && cropTarget === item.target ? temporaryRect : item.rect;
      if (!rect) continue;
      context.lineWidth = cropTarget === item.target ? 4 : 2; context.strokeStyle = item.color;
      context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      context.font = '13px Segoe UI, sans-serif'; context.fillStyle = item.color;
      const labelY = Math.max(17, rect.y - 3); context.fillRect(rect.x - 1, labelY - 16, 64, 19); context.fillStyle = '#101010'; context.fillText(item.label, rect.x + 4, labelY - 2);
    }
  }
  function applyDetection(detection) {
    invalidate(); board = detection.board; uncertain = detection.uncertain; boardRect = detection.rect;
    pieceRects = detection.pieces.map(piece => piece.rect); pieces = detection.pieces.map(piece => toEditor(piece.matrix));
    renderBoard(); renderPieces(); drawScreenshot();
    const found = presentPieces().filter(Boolean).length;
    const caution = detection.boardConfidence === 'low' || detection.pieces.some(piece => piece.matrix && piece.confidence === 'low');
    notice('imageNotice', `${found} balok terbaca. ${caution ? 'Sebagian area belum jelas. Atur area atau perbaiki sel secara manual.' : 'Periksa kembali papan dan semua balok sebelum mencari langkah.'}${uncertain.length ? ' Sel bergaris putus-putus perlu diperiksa.' : ''}`, caution);
  }
  async function loadImage(file) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) { notice('imageNotice', 'Gunakan gambar PNG, JPG, atau WebP.', true); return; }
    if (file.size > 15 * 1024 * 1024) { notice('imageNotice', 'Ukuran gambar maksimal 15 MB.', true); return; }
    const generation = ++imageGeneration; invalidate(); notice('imageNotice', 'Membaca gambar di perangkatmu…');
    try {
      const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (generation !== imageGeneration) { image.close(); return; }
      if (image.width < 120 || image.height < 120 || image.width * image.height > 40_000_000) { image.close(); throw new Error('Gunakan screenshot dengan ukuran wajar dan seluruh papan terlihat.'); }
      const scale = Math.min(1, 1400 / image.height, 1000 / image.width);
      const canvas = $('imageCanvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0, canvas.width, canvas.height); image.close();
      imagePixels = context.getImageData(0, 0, canvas.width, canvas.height);
      $('imageWorkspace').hidden = false; $('dropZone').hidden = true; $('imageName').textContent = file.name || 'Screenshot dari clipboard';
      await new Promise(resolve => setTimeout(resolve, 30));
      if (generation !== imageGeneration) return;
      applyDetection(detectScreenshot(imagePixels));
    } catch (error) { if (generation === imageGeneration) notice('imageNotice', error.message || 'Gambar tidak dapat dibaca. Coba screenshot lain.', true); }
    finally { $('screenshotInput').value = ''; }
  }
  $('screenshotInput').addEventListener('change', event => loadImage(event.target.files?.[0]));
  document.addEventListener('paste', event => {
    const item = [...(event.clipboardData?.items || [])].find(item => item.kind === 'file' && item.type.startsWith('image/'));
    if (item) { event.preventDefault(); loadImage(item.getAsFile()); }
  });
  $('dropZone').addEventListener('dragover', event => { event.preventDefault(); $('dropZone').classList.add('dragover'); });
  $('dropZone').addEventListener('dragleave', () => $('dropZone').classList.remove('dragover'));
  $('dropZone').addEventListener('drop', event => { event.preventDefault(); $('dropZone').classList.remove('dragover'); loadImage(event.dataTransfer?.files?.[0]); });
  $('removeImage').addEventListener('click', () => {
    imageGeneration++; imagePixels = null; boardRect = null; pieceRects = []; drag = null;
    $('imageCanvas').width = $('imageCanvas').height = 0; $('imageWorkspace').hidden = true; $('dropZone').hidden = false;
    notice('imageNotice'); $('screenshotInput').value = '';
    // Keep corrected board/pieces so removing the reference doesn't erase work.
  });
  $('detectAgain').addEventListener('click', () => { if (imagePixels) applyDetection(detectScreenshot(imagePixels, { boardRect, pieceRects })); });
  document.querySelectorAll('[data-crop]').forEach(button => button.addEventListener('click', () => {
    cropTarget = button.dataset.crop;
    document.querySelectorAll('[data-crop]').forEach(item => item.setAttribute('aria-pressed', String(item === button))); drawScreenshot();
  }));
  function point(event) {
    const bounds = $('imageCanvas').getBoundingClientRect();
    return { x: Math.max(0, Math.min(imagePixels.width - 1, (event.clientX - bounds.left) * imagePixels.width / bounds.width)), y: Math.max(0, Math.min(imagePixels.height - 1, (event.clientY - bounds.top) * imagePixels.height / bounds.height)) };
  }
  function selection(end) {
    let width = Math.abs(end.x - drag.x), height = Math.abs(end.y - drag.y);
    if (cropTarget === 'board') width = height = Math.min(width, height);
    return { x: end.x < drag.x ? drag.x - width : drag.x, y: end.y < drag.y ? drag.y - height : drag.y, width, height };
  }
  $('imageCanvas').addEventListener('pointerdown', event => {
    if (!imagePixels) return; drag = point(event); $('imageCanvas').setPointerCapture?.(event.pointerId); event.preventDefault();
  });
  $('imageCanvas').addEventListener('pointermove', event => { if (drag && imagePixels) drawScreenshot(selection(point(event))); });
  $('imageCanvas').addEventListener('pointerup', event => {
    if (!drag || !imagePixels) return;
    const rect = selection(point(event)); drag = null;
    if (rect.width < 12 || rect.height < 12) { drawScreenshot(); return; }
    invalidate();
    if (cropTarget === 'board') {
      const detection = readBoard(imagePixels, rect); boardRect = detection.rect; board = detection.board; uncertain = detection.uncertain; renderBoard();
    } else {
      const index = Number(cropTarget), detection = readPiece(imagePixels, rect, boardRect.width / 8);
      pieceRects[index] = detection.rect; pieces[index] = toEditor(detection.matrix); renderPieces();
    }
    drawScreenshot(); notice('imageNotice', 'Area dibaca ulang. Periksa sel papan dan bentuk balok, lalu centang konfirmasinya.');
  });
  $('imageCanvas').addEventListener('pointercancel', () => { drag = null; drawScreenshot(); });
  window.addEventListener('pagehide', () => { imageGeneration++; stop(); imagePixels = null; });
  renderBoard(); renderPieces(); syncComboHint();
}
