const $ = (id) => document.getElementById(id);
const validRoom = (value) => /^(?:\d{6}|[A-Za-z0-9_-]{22})$/.test(value || '');
const MAX_TEXT_BYTES = 1_000_000;
const MAX_FILE_BYTES = 5_000_000;
let selectedFile = null;
let room = '';
let etag = '';
let timer = null;
let revision = 0;
let lastFingerprint = '';
let pendingPoll = null;
let publishing = false;
let latestNotes = [];
let active = true;

function notice(message = '', error = false) {
  $('pasteNotice').textContent = message;
  $('pasteNotice').hidden = !message;
  $('pasteNotice').classList.toggle('error', error);
}

function randomRoom() {
  const number = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(number).padStart(6, '0');
}

function readRoom(input) {
  let value = (input || '').trim();
  if (value.includes('#')) value = value.slice(value.indexOf('#') + 1);
  if (value.startsWith('r=')) value = new URLSearchParams(value).get('r') || '';
  if (/^\d{3}[\s-]+\d{3}$/.test(value)) value = value.replace(/[\s-]+/g, '');
  return validRoom(value) ? value : '';
}

function shareLink() { return `${location.origin}/paste#r=${room}`; }

function setRoom(value) {
  room = value;
  revision++;
  etag = '';
  lastFingerprint = '';
  pendingPoll?.abort();
  pendingPoll = null;
  clearTimeout(timer);
  history.replaceState(null, '', `${location.pathname}${location.search}#r=${room}`);
  $('roomName').textContent = room;
  $('roomName').title = room;
  $('joinRoomInput').value = room;
  $('roomName').closest('.room-panel').classList.add('connected');
  for (const id of ['copyCodeButton', 'copyRoomButton', 'pasteSubject', 'pasteInput', 'pasteExpiry', 'publishPasteButton', 'pasteSearch', 'chooseFileButton', 'pasteFile']) $(id).disabled = false;
  updateSize();
  $('roomLinkFallback').hidden = true;
  $('pasteSearch').value = '';
  $('pasteSyncStatus').textContent = 'Menghubungkan…';
  notice();
  renderNotes([]);
  poll();
}

function showPanel(panel) {
  const chat = panel === 'chat';
  $('pastePanel').hidden = chat;
  $('chatPanel').hidden = !chat;
  $('settingsButton').hidden = !chat;
  $('sessionLabel').textContent = chat ? 'Sesi sementara' : 'Tanpa login';
  $('footerNote').textContent = chat ? 'Jawaban AI bisa keliru. Periksa hal yang penting.' : 'Sedikit ruang untuk melanjutkan pekerjaanmu.';
  for (const id of ['pasteTab', 'chatTab']) {
    const active = (id === 'chatTab') === chat;
    $(id).classList.toggle('active', active);
    if (active) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (chat) document.dispatchEvent(new CustomEvent('relay:show-chat'));
  else poll();
}
$('newRoomButton').addEventListener('click', () => { setRoom(randomRoom()); $('pasteSubject').focus(); });

async function copyRoom(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    notice(message);
  } catch {
    $('roomLinkFallback').value = value;
    $('roomLinkFallback').hidden = false;
    $('roomLinkFallback').focus();
    $('roomLinkFallback').select();
    notice('Salin teks yang dipilih.');
  }
}
$('copyRoomButton').addEventListener('click', () => copyRoom(shareLink(), 'Tautan tersalin.'));
$('copyCodeButton').addEventListener('click', () => copyRoom(room, 'Kode tersalin.'));

$('joinRoomForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = readRoom($('joinRoomInput').value);
  if (!value) { notice('Masukkan kode 6 angka atau tautan ruang.', true); $('joinRoomInput').focus(); return; }
  setRoom(value);
  $('pasteSubject').focus();
});

async function api(method, path = '', body, { signal, roomValue = room, ifNoneMatch = '' } = {}) {
  const headers = { 'x-paste-room': roomValue };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
  const response = await fetch(`/api/paste${path}`, { method, headers, cache: 'no-store', credentials: 'omit',
    body: body === undefined ? undefined : JSON.stringify(body), signal });
  if (response.status === 304 || response.status === 204) return { response };
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Papan teks belum terhubung. Coba lagi sebentar.'); }
  if (!response.ok) throw new Error(payload.error?.message || 'Permintaan belum berhasil. Coba lagi.');
  return { response, payload };
}

function remaining(expiresAt) {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.ceil(minutes / 60)} jam lagi` : `${minutes} menit lagi`;
}

function renderNotes(notes) {
  latestNotes = notes;
  const query = $('pasteSearch').value.trim().toLocaleLowerCase('id');
  const fingerprint = JSON.stringify([query, notes.map((note) => [note.id, note.subject, note.file?.name, note.file?.size, Math.ceil((note.expiresAt - Date.now()) / 60_000)])]);
  if (fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;
  $('pasteCount').textContent = String(notes.length);
  const number = Math.max(0, ...notes.map(note => Number(/^Memo (\d+)$/.exec(note.subject || '')?.[1] || 0)));
  $('pasteSubject').placeholder = `Memo ${number + 1}`;
  $('clearSearchButton').hidden = !query;
  const list = $('pasteList');
  list.replaceChildren();
  const filtered = notes.map((note, index) => ({ ...note, subject: note.subject || `Memo ${notes.length - index}` }))
    .filter(note => `${note.subject}\n${note.text}\n${note.file?.name || ''}`.toLocaleLowerCase('id').includes(query));
  if (!filtered.length) {
    const empty = document.createElement('div'); empty.className = 'paste-empty';
    empty.textContent = query ? 'Tidak ada memo yang cocok.' : 'Belum ada memo';
    list.append(empty); return;
  }
  for (const note of filtered) {
    const article = document.createElement('article'); article.className = 'paste-card'; article.dataset.noteId = note.id;
    const top = document.createElement('div'); top.className = 'paste-card-top';
    const heading = document.createElement('h3'); heading.textContent = note.subject;
    const time = document.createElement('span'); time.className = 'paste-card-time'; time.textContent = `Hapus dalam ${remaining(note.expiresAt).replace(' lagi', '')}`;
    const actions = document.createElement('div'); actions.className = 'paste-card-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Salin';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(note.text); copy.textContent = 'Tersalin'; }
      catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range); notice('Teks dipilih. Gunakan menu Salin atau Ctrl+C.'); }
    });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Hapus';
    remove.setAttribute('aria-label', 'Hapus teks ini dari ruang');
    const noteRoom = room;
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await api('DELETE', `/${note.id}`, undefined, { roomValue: noteRoom });
        if (noteRoom === room) { etag = ''; await poll(); }
      } catch (error) { notice(error.message, true); remove.disabled = false; }
    });
    if (note.text) actions.append(copy);
    actions.append(remove); top.append(heading, actions);
    const text = document.createElement('pre'); text.className = 'paste-text';
    const preview = note.text.length > 16_000 ? `${note.text.slice(0, 16_000)}…` : note.text;
    text.textContent = preview;
    article.append(top);
    if (note.text) article.append(text);
    if (note.file) {
      const attachment = document.createElement('div'); attachment.className = 'memo-file';
      const info = document.createElement('div');
      const name = document.createElement('span'); name.className = 'memo-file-name'; name.textContent = note.file.name;
      const size = document.createElement('span'); size.className = 'memo-file-size'; size.textContent = fileSize(note.file.size);
      info.append(name, size);
      const download = document.createElement('button'); download.type = 'button'; download.className = 'memo-download'; download.textContent = 'Unduh';
      const fileRoom = room;
      download.addEventListener('click', async () => {
        download.disabled = true;
        try {
          const { payload } = await api('GET', `/files/${note.id}/download`, undefined, { roomValue: fileRoom });
          const link = document.createElement('a'); link.href = payload.url; link.download = payload.fileName; link.rel = 'noopener';
          document.body.append(link); link.click(); link.remove();
        } catch (error) { notice(error.message, true); }
        finally { download.disabled = false; }
      });
      attachment.append(info, download); article.append(attachment);
    }
    if (preview !== note.text) {
      const expand = document.createElement('button'); expand.type = 'button'; expand.className = 'paste-expand';
      expand.textContent = 'Buka teks lengkap'; expand.setAttribute('aria-expanded', 'false');
      expand.addEventListener('click', () => {
        const open = expand.getAttribute('aria-expanded') !== 'true';
        expand.setAttribute('aria-expanded', String(open));
        expand.textContent = open ? 'Ringkas tampilan' : 'Buka teks lengkap';
        text.textContent = open ? note.text : preview;
      });
      article.append(expand);
    }
    article.append(time); list.append(article);
  }
}
$('pasteSearch').addEventListener('input', () => renderNotes(latestNotes));
$('clearSearchButton').addEventListener('click', () => { $('pasteSearch').value = ''; renderNotes(latestNotes); $('pasteSearch').focus(); });

function fileSize(bytes) { return bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} KB` : `${(bytes / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 2 })} MB`; }
function clearFile() {
  selectedFile = null; $('pasteFile').value = ''; $('selectedFile').hidden = true; $('pasteInput').required = true;
}
$('chooseFileButton').addEventListener('click', () => $('pasteFile').click());
$('pasteFile').addEventListener('change', () => {
  const file = $('pasteFile').files?.[0];
  if (!file) return;
  if (file.size < 1 || file.size > MAX_FILE_BYTES) { notice('Ukuran file harus antara 1 byte dan 5 MB.', true); $('pasteFile').value = ''; return; }
  if (!/\.(docx?|xlsx?|pptx?|pdf|txt|csv|png|jpe?g|webp|gif)$/i.test(file.name)) { notice('Gunakan Word, Excel, PowerPoint, PDF, gambar, TXT, atau CSV.', true); $('pasteFile').value = ''; return; }
  selectedFile = file; $('selectedFileName').textContent = file.name; $('selectedFileSize').textContent = fileSize(file.size);
  $('selectedFile').hidden = false; $('pasteInput').required = false; notice();
});
$('clearFileButton').addEventListener('click', clearFile);

function updateSize() {
  const bytes = new TextEncoder().encode($('pasteInput').value).length;
  const size = bytes < 1000 ? `${bytes} B` : bytes < MAX_TEXT_BYTES ? `${(bytes / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} KB` : `${(bytes / MAX_TEXT_BYTES).toLocaleString('id-ID', { maximumFractionDigits: 2 })} MB`;
  $('pasteSize').textContent = size;
  $('pasteSize').closest('.paste-requirements').classList.toggle('over-limit', bytes > MAX_TEXT_BYTES);
  $('pasteInput').setCustomValidity(bytes > MAX_TEXT_BYTES ? 'Teks terlalu panjang. Maksimal 1 MB.' : '');
  $('publishPasteButton').disabled = publishing || !room || bytes > MAX_TEXT_BYTES;
  return bytes;
}
$('pasteInput').addEventListener('input', updateSize);

async function poll() {
  clearTimeout(timer);
  if (!active || !room || document.hidden || $('pastePanel').hidden || pendingPoll) return;
  const controller = new AbortController();
  const currentRevision = revision;
  pendingPoll = controller;
  try {
    const { response, payload } = await api('GET', '', undefined, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(18_000)]), ifNoneMatch: etag,
    });
    if (currentRevision !== revision) return;
    if (payload) { etag = response.headers.get('etag') || ''; renderNotes(payload.notes || []); }
    else renderNotes(latestNotes);
    $('pasteSyncStatus').textContent = 'Tersinkron';
    $('pasteSyncStatus').classList.remove('offline');
  } catch (error) {
    if (currentRevision !== revision || controller.signal.aborted) return;
    $('pasteSyncStatus').textContent = 'Menghubungkan ulang…';
    $('pasteSyncStatus').classList.add('offline');
  } finally {
    const ownsPoll = pendingPoll === controller;
    if (ownsPoll) pendingPoll = null;
    if (active && ownsPoll && currentRevision === revision) timer = setTimeout(poll, 3000);
  }
}

$('pasteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (publishing || !room) return;
  const text = $('pasteInput').value;
  if (!text.trim() && !selectedFile) return;
  if (updateSize() > MAX_TEXT_BYTES) { notice('Teks terlalu panjang. Maksimal 1 MB.', true); return; }
  const currentRoom = room;
  const currentRevision = revision;
  const file = selectedFile;
  let pendingFileId = '';
  publishing = true;
  $('publishPasteButton').disabled = true;
  notice();
  $('chooseFileButton').disabled = true; $('pasteFile').disabled = true; $('clearFileButton').disabled = true;
  try {
    const body = { text, subject: $('pasteSubject').value.trim(), ttlSeconds: Number($('pasteExpiry').value) };
    $('publishLabel').textContent = file ? 'Menyiapkan…' : 'Mengirim…';
    if (file) {
      const { payload } = await api('POST', '/files', { ...body, fileName: file.name, fileSize: file.size }, { roomValue: currentRoom, signal: AbortSignal.timeout(25_000) });
      pendingFileId = payload.noteId;
      $('publishLabel').textContent = 'Mengunggah…';
      const uploaded = await fetch(payload.uploadUrl, { method: 'PUT', headers: { 'content-type': payload.contentType, 'x-upsert': 'false', 'cache-control': '0' },
        body: file, credentials: 'omit', signal: AbortSignal.timeout(120_000) });
      if (!uploaded.ok) throw new Error('Unggahan belum berhasil. Coba lagi.');
      $('publishLabel').textContent = 'Menyimpan…';
      await api('POST', `/files/${pendingFileId}/complete`, undefined, { roomValue: currentRoom, signal: AbortSignal.timeout(25_000) });
      pendingFileId = '';
    } else {
      await api('POST', '', body, { roomValue: currentRoom, signal: AbortSignal.timeout(18_000) });
    }
    if (currentRevision !== revision) return;
    $('pasteInput').value = '';
    $('pasteSubject').value = '';
    clearFile();
    notice('Memo terkirim.');
    etag = '';
    if (pendingPoll) { pendingPoll.abort(); pendingPoll = null; }
    await poll();
  } catch (error) {
    if (pendingFileId) { try { await api('DELETE', `/${pendingFileId}`, undefined, { roomValue: currentRoom }); } catch { /* Server cleanup retries. */ } }
    if (currentRevision === revision) notice(error.message, true);
  }
  finally {
    publishing = false; $('publishLabel').textContent = 'Kirim memo';
    $('chooseFileButton').disabled = !room; $('pasteFile').disabled = !room; $('clearFileButton').disabled = false;
    updateSize();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearTimeout(timer); pendingPoll?.abort(); }
  else poll();
});
window.addEventListener('focus', poll);
window.addEventListener('hashchange', () => {
  const value = readRoom(location.hash);
  if (value && value !== room) setRoom(value);
  else if (!value) notice('Kode pada tautan tidak lengkap. Masukkan kode 6 angka dari perangkat satunya.', true);
});
window.addEventListener('pagehide', () => { active = false; clearTimeout(timer); pendingPoll?.abort(); });
window.addEventListener('pageshow', () => { active = true; poll(); });
document.body.classList.toggle('paste-page', location.pathname.replace(/\/$/, '') !== '/chat');
if (location.pathname.replace(/\/$/, '') === '/chat') {
  showPanel('chat');
  document.title = 'Chat AI — Solver.me';
} else {
  const initialHash = location.hash;
  const initialRoom = readRoom(initialHash);
  if (initialRoom) setRoom(initialRoom);
  if (initialHash && !initialRoom) notice('Kode pada tautan tidak lengkap. Masukkan kode 6 angka dari perangkat satunya.', true);
  document.title = 'Papan teks — Solver.me';
}
