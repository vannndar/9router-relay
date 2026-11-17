// Local, deterministic recognition for an idle Classic screenshot. Ambiguous
// themes can always be corrected in the editor; no image leaves this device.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const luminance = color => color[0] * .2126 + color[1] * .7152 + color[2] * .0722;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

function pixel(image, x, y) {
  const i = (clamp(Math.round(y), 0, image.height - 1) * image.width + clamp(Math.round(x), 0, image.width - 1)) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function patch(image, x, y, radius = 2) {
  const samples = [];
  for (const dy of [-radius, 0, radius]) for (const dx of [-radius, 0, radius]) samples.push(pixel(image, x + dx, y + dy));
  return [0, 1, 2].map(channel => median(samples.map(sample => sample[channel])));
}

function boundedRect(image, rect, square = false) {
  const x = clamp(Math.round(rect.x), 0, image.width - 8), y = clamp(Math.round(rect.y), 0, image.height - 8);
  let width = clamp(Math.round(rect.width), 8, image.width - x);
  let height = clamp(Math.round(rect.height), 8, image.height - y);
  if (square) width = height = Math.min(width, height);
  return { x, y, width, height };
}

function gridScore(image, x, y, size) {
  const pitch = size / 8, offset = Math.max(2, pitch * .16);
  let horizontal = 0, vertical = 0, hHits = 0, vHits = 0;
  for (let line = 1; line < 8; line++) for (let cell = 0; cell < 8; cell++) {
    const a = x + line * pitch, b = y + (cell + .5) * pitch;
    const v = Math.max(0, (luminance(pixel(image, a - offset, b)) + luminance(pixel(image, a + offset, b))) / 2 - luminance(pixel(image, a, b)));
    const c = x + (cell + .5) * pitch, d = y + line * pitch;
    const h = Math.max(0, (luminance(pixel(image, c, d - offset)) + luminance(pixel(image, c, d + offset))) / 2 - luminance(pixel(image, c, d)));
    vertical += v; horizontal += h; vHits += Number(v > 3); hHits += Number(h > 3);
  }
  // Repeated grid seams also align when the crop is shifted by a whole row.
  // The true board has background outside ALL four sides; a shifted crop has
  // occupied/empty board cells outside its top or bottom edge instead.
  const sideSamples = [pixel(image, 1, y + size * .35), pixel(image, image.width - 2, y + size * .35),
    pixel(image, 1, y + size * .65), pixel(image, image.width - 2, y + size * .65)];
  const background = [0,1,2].map(channel => median(sideSamples.map(color => color[channel])));
  let outsideMatches = 0;
  const margin = Math.max(5, pitch * .13);
  for (let cell = 0; cell < 8; cell++) {
    for (const color of [pixel(image, x + (cell + .5) * pitch, y - margin),
      pixel(image, x + (cell + .5) * pitch, y + size + margin),
      pixel(image, x - margin, y + (cell + .5) * pitch),
      pixel(image, x + size + margin, y + (cell + .5) * pitch)]) outsideMatches += Number(distance(color, background) < 42);
  }
  const seamScore = (Math.min(horizontal, vertical) * .7 + (horizontal + vertical) * .15) / 56 + Math.min(vHits, hHits) * .12;
  return seamScore * (outsideMatches / 32) ** 3;
}

export function findBoardRect(image) {
  const { width: w, height: h } = image;
  let best = { x: w * .04, y: h * .26, width: w * .92, height: w * .92, score: -1 };
  const sizeStep = Math.max(4, w / 65), yStep = Math.max(4, h / 180), xStep = Math.max(3, w / 50);
  for (let size = w * .76; size <= w * .99; size += sizeStep) {
    for (let x = Math.max(0, (w - size) / 2 - w * .035); x <= Math.min(w - size, (w - size) / 2 + w * .035); x += xStep) {
      for (let y = h * .12; y <= Math.min(h * .65, h - size - 8); y += yStep) {
        const score = gridScore(image, x, y, size);
        if (score > best.score) best = { x, y, width: size, height: size, score };
      }
    }
  }
  const coarse = best;
  for (let size = coarse.width - sizeStep; size <= coarse.width + sizeStep; size += 2) {
    for (let x = coarse.x - xStep; x <= coarse.x + xStep; x += 2) {
      if (x < 0 || x + size > w) continue;
      for (let y = coarse.y - yStep; y <= coarse.y + yStep; y += 2) {
        if (y < 0 || y + size > h) continue;
        const score = gridScore(image, x, y, size);
        if (score > best.score) best = { x, y, width: size, height: size, score };
      }
    }
  }
  return { ...boundedRect(image, best, true), confidence: best.score > 7 ? 'high' : 'low' };
}

export function readBoard(image, rectangle) {
  const rect = boundedRect(image, rectangle, true), pitch = rect.width / 8;
  const colors = Array.from({ length: 64 }, (_, i) => patch(image, rect.x + (i % 8 + .5) * pitch, rect.y + (Math.floor(i / 8) + .5) * pitch, pitch * .15));
  const clusters = [];
  colors.forEach(color => {
    const cluster = clusters.find(item => distance(item.color, color) < 28);
    if (cluster) cluster.count++; else clusters.push({ color, count: 1 });
  });
  const repeated = clusters.filter(cluster => cluster.count >= 2);
  const empty = (repeated.length ? repeated : clusters).sort((a, b) => luminance(a.color) - luminance(b.color))[0].color;
  const board = Array(8).fill(0), uncertain = [];
  colors.forEach((color, i) => {
    const diff = distance(color, empty);
    if (diff > 38) board[Math.floor(i / 8)] |= 1 << (i % 8);
    if (diff > 23 && diff < 52) uncertain.push(i);
  });
  return { board, uncertain, rect };
}

export function defaultPieceRects(image, boardRect) {
  const top = boardRect.y + boardRect.height + boardRect.width * .035;
  return Array.from({ length: 3 }, (_, i) => boundedRect(image, {
    x: boardRect.x + boardRect.width * i / 3, y: top,
    width: boardRect.width / 3, height: Math.min(boardRect.width * .39, image.height - top - image.height * .03),
  }));
}

export function readPiece(image, rectangle, boardPitch) {
  const rect = boundedRect(image, rectangle);
  const background = [0, 1, 2].map(channel => median([
    pixel(image, rect.x + 2, rect.y + 2)[channel], pixel(image, rect.x + rect.width - 3, rect.y + 2)[channel],
    pixel(image, rect.x + 2, rect.y + rect.height - 3)[channel], pixel(image, rect.x + rect.width - 3, rect.y + rect.height - 3)[channel],
  ]));
  const stride = Math.max(1, Math.round(boardPitch / 22));
  const mw = Math.ceil(rect.width / stride), mh = Math.ceil(rect.height / stride), mask = new Uint8Array(mw * mh);
  let left = mw, right = -1, top = mh, bottom = -1, count = 0;
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const color = pixel(image, rect.x + x * stride, rect.y + y * stride);
    const light = luminance(color), saturation = (Math.max(...color) - Math.min(...color)) / Math.max(1, ...color);
    if (distance(color, background) > 55 && light > luminance(background) + 22 && saturation > .24) mask[y * mw + x] = 1;
  }
  // Remove stray pixels (scores, sparkles, compression edges) before fitting.
  const seen = new Uint8Array(mask.length), components = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    const component = [], queue = [i]; seen[i] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const p = queue[cursor]; component.push(p);
      const x = p % mw, y = Math.floor(p / mw);
      for (const q of [x ? p - 1 : -1, x + 1 < mw ? p + 1 : -1, y ? p - mw : -1, y + 1 < mh ? p + mw : -1]) {
        if (q >= 0 && mask[q] && !seen[q]) { seen[q] = 1; queue.push(q); }
      }
    }
    components.push(component);
  }
  const largest = Math.max(0, ...components.map(component => component.length));
  mask.fill(0);
  for (const component of components) if (component.length >= Math.max(8, largest * .12)) {
    for (const p of component) {
      mask[p] = 1; count++;
      const x = p % mw, y = Math.floor(p / mw);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (count < 16 || right < left) return { matrix: null, confidence: 'low', rect };
  const width = right - left + 1, height = bottom - top + 1, expectedPitch = boardPitch * .56 / stride;
  let best = null;
  for (let rows = 1; rows <= 5; rows++) for (let cols = 1; cols <= 5; cols++) {
    // Outer bounds exclude the narrow gap at the outside of the last cell.
    const px = width / (cols - .10), py = height / (rows - .10), pitch = (px + py) / 2;
    if (Math.abs(px - py) / pitch > .19 || pitch < boardPitch * .28 / stride || pitch > boardPitch * .95 / stride) continue;
    const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));
    let correct = 0, total = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      let occupied = 0, samples = 0;
      for (const dy of [.28, .5, .72]) for (const dx of [.28, .5, .72]) {
        const x = Math.round(left + (c + dx) * px - px * .05), y = Math.round(top + (r + dy) * py - py * .05);
        occupied += mask[clamp(y, 0, mh - 1) * mw + clamp(x, 0, mw - 1)]; samples++;
      }
      matrix[r][c] = Number(occupied / samples > .5);
    }
    if (!matrix.flat().some(Boolean)) continue;
    for (let y = top; y <= bottom; y += 2) for (let x = left; x <= right; x += 2) {
      const c = clamp(Math.floor((x - left + px * .05) / px), 0, cols - 1);
      const r = clamp(Math.floor((y - top + py * .05) / py), 0, rows - 1);
      const fx = (x - left + px * .05) / px - c, fy = (y - top + py * .05) / py - r;
      const predicted = matrix[r][c] && fx > .06 && fx < .94 && fy > .06 && fy < .94;
      correct += Number(Boolean(predicted) === Boolean(mask[y * mw + x])); total++;
    }
    const fit = correct / Math.max(1, total);
    const score = fit - Math.abs(Math.log(pitch / expectedPitch)) * .12 - Math.abs(px - py) / pitch * .1;
    if (!best || score > best.score) best = { matrix, score, fit };
  }
  return { matrix: best?.matrix || null, confidence: best && best.fit > .83 ? 'high' : 'low', rect };
}

export function detectScreenshot(image, { boardRect, pieceRects } = {}) {
  const found = boardRect || findBoardRect(image);
  const board = readBoard(image, found);
  const rects = pieceRects || defaultPieceRects(image, board.rect);
  const pieces = rects.map(rect => readPiece(image, rect, board.rect.width / 8));
  return { ...board, boardConfidence: found.confidence || 'manual', pieces };
}
