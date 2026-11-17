// Pointer painting uses one fill/erase value for the whole stroke. Exact segment
// intersections cover cells between sparse pointer events, including fast swipes.
export function enableGridPainting(container, { columns, rows, read, write, onChange }) {
  let stroke = null, suppressClick = false;
  const document = container.ownerDocument, view = document.defaultView;

  function cellFromTarget(target) {
    const cell = target?.closest?.('[data-cell]');
    return cell?.parentElement === container ? cell : null;
  }
  function geometry() {
    const first = container.children[0].getBoundingClientRect();
    const next = container.children[1]?.getBoundingClientRect();
    const below = container.children[columns]?.getBoundingClientRect();
    const last = container.children[columns * rows - 1].getBoundingClientRect();
    return { left: first.left, top: first.top, right: last.right, bottom: last.bottom,
      width: first.width, height: first.height,
      stepX: columns > 1 ? next.left - first.left : first.width,
      stepY: rows > 1 ? below.top - first.top : first.height };
  }
  function apply(indices) {
    let changed = false;
    for (const index of indices) {
      if (index < 0 || index >= columns * rows || stroke.visited.has(index)) continue;
      stroke.visited.add(index);
      if (Boolean(read(index)) !== stroke.value) { write(index, stroke.value); changed = true; }
    }
    if (changed) onChange();
  }
  function segment(from, to) {
    const g = stroke.geometry;
    if (g.width <= 0 || g.height <= 0 || g.stepX <= 0 || g.stepY <= 0) return;
    const dx = to.x - from.x, dy = to.y - from.y;
    function intersects(left, top, right, bottom) {
      let start = 0, end = 1;
      for (const [p, q] of [[-dx, from.x - left], [dx, right - from.x], [-dy, from.y - top], [dy, bottom - from.y]]) {
        if (!p) { if (q < 0) return null; continue; }
        const t = q / p;
        if (p < 0) start = Math.max(start, t); else end = Math.min(end, t);
        if (start > end) return null;
      }
      return start;
    }
    if (intersects(g.left, g.top, g.right, g.bottom) === null) return;
    const touched = [];
    // At most 64 cells: bounded work even for distant pointer coordinates.
    // Testing the actual cell interiors preserves gaps and short corner crossings.
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const left = g.left + col * g.stepX, top = g.top + row * g.stepY;
      const time = intersects(left, top, left + g.width, top + g.height);
      if (time !== null) touched.push({ index: row * columns + col, time });
    }
    touched.sort((a, b) => a.time - b.time);
    apply(touched.map(cell => cell.index));
  }
  function finish() {
    if (!stroke) return;
    const pointerId = stroke.pointerId; stroke = null;
    try { if (container.hasPointerCapture?.(pointerId)) container.releasePointerCapture(pointerId); } catch { /* The browser may already have released a cancelled pointer. */ }
  }
  container.addEventListener('pointerdown', event => {
    if (stroke || event.isPrimary === false || event.button !== 0) return;
    const cell = cellFromTarget(event.target);
    if (!cell) return;
    const index = Number(cell.dataset.cell);
    stroke = { pointerId: event.pointerId, value: !Boolean(read(index)), visited: new Set(),
      previous: { x: event.clientX, y: event.clientY }, geometry: geometry() };
    suppressClick = true;
    event.preventDefault(); cell.focus({ preventScroll: true });
    try { container.setPointerCapture?.(event.pointerId); } catch { /* Document listeners still cover mouse/touch events. */ }
    apply([index]);
  });
  document.addEventListener('pointermove', event => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    if (event.buttons === 0) { finish(); return; }
    event.preventDefault();
    const samples = [...(event.getCoalescedEvents?.() || []), event];
    for (const sample of samples) {
      const point = { x: sample.clientX, y: sample.clientY };
      segment(stroke.previous, point); stroke.previous = point;
    }
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    segment(stroke.previous, { x: event.clientX, y: event.clientY }); finish();
  });
  document.addEventListener('pointercancel', event => { if (stroke?.pointerId === event.pointerId) finish(); });
  container.addEventListener('lostpointercapture', event => { if (stroke?.pointerId === event.pointerId) finish(); });
  view.addEventListener('blur', finish);
  container.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) { suppressClick = false; event.preventDefault(); return; }
    const cell = cellFromTarget(event.target);
    if (!cell) return;
    // Enter, Space and assistive technology still activate a single cell.
    const index = Number(cell.dataset.cell);
    write(index, !Boolean(read(index))); onChange();
  });
}
