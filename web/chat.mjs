import { readSseData } from './stream.mjs';

const $ = (id) => document.getElementById(id);
const dialog = $('connectionDialog');
const tokenInput = $('tokenInput');
const input = $('promptInput');
const modelSelect = $('modelSelect');
const messages = $('messages');
const history = [];
let token = '';
let activeRequest = null;

function showNotice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function setBusy(busy) {
  $('sendButton').hidden = busy;
  $('stopButton').hidden = !busy;
  $('sendButton').disabled = !token || !input.value.trim();
  modelSelect.disabled = busy || !token;
}

function resetConversation() {
  const running = activeRequest;
  activeRequest = null;
  running?.abort();
  history.length = 0;
  messages.replaceChildren();
  messages.hidden = true;
  $('welcome').hidden = false;
  input.value = '';
  input.style.height = '';
  showNotice();
  setBusy(false);
}

function disconnect() {
  token = '';
  tokenInput.value = '';
  resetConversation();
  input.disabled = true;
  modelSelect.replaceChildren(new Option('Belum terhubung', ''));
  $('modelDot').classList.remove('connected');
  $('newChatButton').disabled = true;
  $('disconnectButton').hidden = true;
  $('chatConnectButton').hidden = false;
}

function openConnection() {
  $('connectionError').hidden = true;
  tokenInput.value = '';
  tokenInput.type = 'password';
  $('revealButton').textContent = 'Lihat';
  if (!dialog.open) dialog.showModal();
  tokenInput.focus();
}

$('settingsButton').addEventListener('click', openConnection);
$('chatConnectButton').addEventListener('click', openConnection);
document.addEventListener('relay:show-chat', () => { if (!token) openConnection(); });
$('closeDialogButton').addEventListener('click', () => dialog.close());
$('revealButton').addEventListener('click', () => {
  const showing = tokenInput.type === 'password';
  tokenInput.type = showing ? 'text' : 'password';
  $('revealButton').textContent = showing ? 'Sembunyi' : 'Lihat';
  $('revealButton').setAttribute('aria-label', showing ? 'Sembunyikan token' : 'Tampilkan token');
});
$('disconnectButton').addEventListener('click', disconnect);
$('newChatButton').addEventListener('click', () => { resetConversation(); input.focus(); });

$('connectionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const proposedToken = tokenInput.value.trim();
  if (!proposedToken) return;
  const button = $('connectButton');
  button.disabled = true;
  button.textContent = 'Menghubungkan…';
  $('connectionError').hidden = true;
  try {
    const response = await fetch('/v1/models', { headers: { authorization: `Bearer ${proposedToken}` },
      cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(20_000) });
    if (response.status === 401) throw new Error('Token belum cocok. Periksa API key relay yang kamu masukkan.');
    if (!response.ok) throw new Error('Relay belum bisa terhubung ke daftar model. Coba lagi sebentar.');
    const payload = await response.json();
    const models = payload.data?.filter((model) => typeof model.id === 'string');
    if (!models?.length) throw new Error('Belum ada model yang tersedia di 9Router.');
    const selected = modelSelect.value;
    models.sort((a, b) => a.id.localeCompare(b.id));
    token = proposedToken;
    tokenInput.value = '';
    modelSelect.replaceChildren(...models.map((model) => new Option(model.id, model.id)));
    modelSelect.value = models.some((model) => model.id === selected) ? selected :
      models.some((model) => model.id === 'simple-setting-and-looking') ? 'simple-setting-and-looking' : models[0].id;
    $('modelDot').classList.add('connected');
    $('newChatButton').disabled = false;
    $('disconnectButton').hidden = false;
    $('chatConnectButton').hidden = true;
    input.disabled = false;
    setBusy(Boolean(activeRequest));
    dialog.close();
    input.focus();
  } catch (error) {
    $('connectionError').textContent = error.name === 'TimeoutError' ? 'Koneksi terlalu lama. Coba hubungkan lagi.' : error.message;
    $('connectionError').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Hubungkan';
  }
});

for (const suggestion of document.querySelectorAll('.suggestion')) {
  suggestion.addEventListener('click', () => {
    if (!token) { openConnection(); return; }
    input.value = suggestion.dataset.prompt.replaceAll('\\n', '\n');
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  $('sendButton').disabled = !token || !input.value.trim();
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!activeRequest && input.value.trim()) $('chatForm').requestSubmit();
  }
});
$('stopButton').addEventListener('click', () => activeRequest?.abort());

function appendInline(parent, text) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code'); code.textContent = part.slice(1, -1); parent.append(code);
    } else if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); parent.append(strong);
    } else parent.append(document.createTextNode(part));
  }
}

function renderAnswer(element, text) {
  const fragment = document.createDocumentFragment();
  let paragraph = [];
  let codeLines = null;
  let list = null;
  const flush = () => {
    if (paragraph.length) { const p = document.createElement('p'); appendInline(p, paragraph.join('\n')); fragment.append(p); paragraph = []; }
    list = null;
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      flush();
      if (codeLines === null) codeLines = [];
      else { const pre = document.createElement('pre'); const code = document.createElement('code'); code.textContent = codeLines.join('\n'); pre.append(code); fragment.append(pre); codeLines = null; }
    } else if (codeLines !== null) codeLines.push(line);
    else if (!line.trim()) flush();
    else if (/^#{1,6}\s/.test(line)) { flush(); const h = document.createElement('h3'); appendInline(h, line.replace(/^#{1,6}\s+/, '')); fragment.append(h); }
    else if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      if (paragraph.length) flush();
      const tag = /^\s*\d+\./.test(line) ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) { list = document.createElement(tag); fragment.append(list); }
      const li = document.createElement('li'); appendInline(li, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')); list.append(li);
    } else { list = null; paragraph.push(line); }
  }
  flush();
  if (codeLines !== null) { const pre = document.createElement('pre'); pre.textContent = codeLines.join('\n'); fragment.append(pre); }
  element.replaceChildren(fragment);
}

function addMessage(role, content = '') {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const body = document.createElement('div'); body.className = 'message-body'; body.textContent = content;
  if (role === 'user') article.append(body);
  else {
    const avatar = document.createElement('span'); avatar.className = 'assistant-avatar'; avatar.textContent = 'r'; avatar.setAttribute('aria-hidden', 'true');
    const main = document.createElement('div'); main.className = 'message-main';
    const label = document.createElement('p'); label.className = 'message-label'; label.textContent = 'Relay';
    const actions = document.createElement('div'); actions.className = 'message-actions';
    const state = document.createElement('span'); state.className = 'message-state'; actions.append(state);
    main.append(label, body, actions); article.append(avatar, main);
    article.state = state; article.actions = actions;
  }
  messages.append(article);
  $('welcome').hidden = true; messages.hidden = false;
  return { article, body };
}

function scrollToReply() {
  const bottom = $('chatForm').getBoundingClientRect().bottom;
  if (bottom > window.innerHeight - 20) window.scrollTo({ top: window.scrollY + bottom - window.innerHeight + 30, behavior: 'instant' });
}

$('chatForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = input.value.trim();
  if (!token || !prompt || activeRequest) return;
  showNotice();
  const controller = new AbortController(); activeRequest = controller;
  history.push({ role: 'user', content: prompt });
  addMessage('user', prompt);
  const reply = addMessage('assistant');
  reply.body.textContent = 'Sedang berpikir'; reply.body.classList.add('thinking');
  input.value = ''; input.style.height = ''; setBusy(true); scrollToReply();
  let answer = '';
  let complete = false;
  let stateLabel = '';
  try {
    const response = await fetch('/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      credentials: 'omit', cache: 'no-store',
      body: JSON.stringify({ model: modelSelect.value, messages: history, stream: true, max_tokens: 2048 }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(285_000)]),
    });
    if (!response.ok) {
      const errors = { 401: 'Token tidak berlaku. Buka pengaturan untuk menghubungkan ulang.',
        429: 'Model sedang mencapai batas penggunaan. Coba model lain atau tunggu sebentar.',
        502: 'Backend belum bisa dijangkau. Coba lagi sebentar.', 504: 'Model membutuhkan waktu terlalu lama. Coba pertanyaan yang lebih singkat.' };
      throw new Error(errors[response.status] || `Permintaan belum berhasil (HTTP ${response.status}). Coba lagi.`);
    }
    if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
      const result = await response.json();
      answer = result.choices?.[0]?.message?.content || '';
      complete = Boolean(answer);
    } else {
      for await (const data of readSseData(response.body)) {
        if (activeRequest !== controller) return;
        if (data.trim() === '[DONE]') { complete = true; break; }
        let packet;
        try { packet = JSON.parse(data); } catch { throw new Error('Respons model tidak dapat dibaca. Coba lagi.'); }
        if (packet.error) throw new Error('Model tidak dapat menyelesaikan respons. Coba model lain.');
        const choice = packet.choices?.[0];
        const piece = choice?.delta?.content;
        if (typeof piece === 'string') answer += piece;
        if (choice?.finish_reason) complete = true;
        if (answer) { reply.body.classList.remove('thinking'); reply.body.textContent = answer; scrollToReply(); }
      }
    }
    if (!answer.trim()) throw new Error('Model belum mengirim jawaban. Coba lagi atau pilih model lain.');
    if (!complete) stateLabel = 'Koneksi berakhir. Jawaban mungkin belum lengkap.';
  } catch (error) {
    if (activeRequest !== controller) return;
    if (controller.signal.aborted) stateLabel = 'Dihentikan';
    else {
      const message = error.name === 'TimeoutError' ? 'Waktu tunggu habis. Coba lagi.' : error.message;
      showNotice(message);
      stateLabel = 'Respons belum selesai';
      reply.article.state.classList.add('error');
    }
  } finally {
    if (activeRequest === controller) {
      activeRequest = null;
      reply.body.classList.remove('thinking');
      reply.body.textContent = '';
      if (answer) {
        renderAnswer(reply.body, answer);
        history.push({ role: 'assistant', content: answer });
        const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Salin jawaban';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(answer); copy.textContent = 'Tersalin'; }
          catch { copy.textContent = 'Pilih teks untuk menyalin'; }
        });
        reply.article.actions.prepend(copy);
      } else reply.body.textContent = controller.signal.aborted ? 'Jawaban dihentikan.' : 'Belum ada jawaban.';
      reply.article.state.textContent = stateLabel;
      setBusy(false);
      input.focus();
    }
  }
});

// No persistence: clear volatile state when navigating away, including back/forward cache.
window.addEventListener('pagehide', disconnect);
window.addEventListener('pageshow', (event) => { if (event.persisted) openConnection(); });
