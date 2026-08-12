'use strict';

// 写真・録音・生成済み音声は端末のIndexedDBに保存する。
// 自然音声を作るときだけ、入力した文章を音声生成APIへ送信する。
const DB_NAME = 'talking-album';
const STORE = 'items';
// 誤操作による大量投入を防ぐ安全上限。実際の保存可否は端末の空き容量も確認する。
const MAX_ITEMS = 300;
const MAX_IMAGE_EDGE = 1600;
const RECORDING_LIMIT_MS = 10000;
const NATURAL_SPEECH_ENDPOINT = 'https://talking-album-voice.ringhio324-lab.workers.dev';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(dbHandle, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = dbHandle.transaction(STORE, mode);
    let request;
    try {
      request = fn(transaction.objectStore(STORE));
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(request && request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('保存を中止しました'));
  });
}

const db = {
  async all() { return tx(await openDb(), 'readonly', store => store.getAll()); },
  async add(item) { return tx(await openDb(), 'readwrite', store => store.add(item)); },
  async put(item) { return tx(await openDb(), 'readwrite', store => store.put(item)); },
  async del(id) { return tx(await openDb(), 'readwrite', store => store.delete(id)); },
  async clear() { return tx(await openDb(), 'readwrite', store => store.clear()); },
};

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const big = document.getElementById('big');
const bigImg = document.getElementById('bigImg');
const bigName = document.getElementById('bigName');
const parent = document.getElementById('parent');
const statusEl = document.getElementById('status');
const listEl = document.getElementById('list');
const parentCount = document.getElementById('parentCount');
const childTools = document.getElementById('childTools');
const bookShelf = document.getElementById('bookShelf');
const quizModeButton = document.getElementById('quizMode');
const slideModeButton = document.getElementById('slideMode');
const modeMessage = document.getElementById('modeMessage');
const urls = [];
const listUrls = [];
let audio = null;
let activePlaybackButton = null;
let activeAudioUrl = null;
let audioContext = null;
let activeSources = [];
const DEFAULT_VOICE = { rate: 1, pitch: 0, volume: 1, effect: 'clean', pattern: 'once', preset: 'normal' };
const CATEGORIES = [
  ['all','ぜんぶ'], ['family','かぞく'], ['animal','どうぶつ'],
  ['food','たべもの'], ['vehicle','のりもの'], ['favorite','おきにいり'], ['other','そのほか'],
];
const BOOKS = [
  ['all', 'すべての ずかん'],
  ['me', 'ぼく・わたし'],
  ['creatures', 'いきもの'],
  ['discoveries', 'みつけたもの'],
  ['free', 'じゆう'],
];
const SPEECH_PRESETS = {
  woman: { rate: 1.02, pitch: 1.25, repeat: 1 }, man: { rate: .9, pitch: .78, repeat: 1 },
  baby: { rate: 1.2, pitch: 1.75, repeat: 2 }, anime: { rate: 1.12, pitch: 1.5, repeat: 1 },
  robot: { rate: .78, pitch: .72, repeat: 2 }, monster: { rate: .68, pitch: .45, repeat: 1 },
  slow: { rate: .7, pitch: 1, repeat: 1 }, random: { rate: 1, pitch: 1, repeat: 1 },
};
const NATURAL_VOICES = {
  woman: 'ja-JP-NanamiNeural', man: 'ja-JP-KeitaNeural', baby: 'ja-JP-AoiNeural',
  anime: 'ja-JP-ShioriNeural', robot: 'ja-JP-NaokiNeural', monster: 'ja-JP-DaichiNeural',
  slow: 'ja-JP-MayuNeural',
};
let selectedBook = 'all';
let quizTargetId = null;
let slideshowTimer = null;
let slideshowIndex = 0;

function voiceOf(item) {
  const saved = { ...(item.voice || {}) };
  if (saved.preset === 'tiny') Object.assign(saved, { ...VOICE_PRESETS.high, preset: 'high' });
  if (saved.preset === 'big') Object.assign(saved, { ...VOICE_PRESETS.low, preset: 'low' });
  if (saved.preset === 'slow') Object.assign(saved, { ...VOICE_PRESETS.low, preset: 'low' });
  return { ...DEFAULT_VOICE, ...saved };
}

function hasSound(item) { return Boolean(item.audio || item.speech?.text); }

function bookOf(item) {
  if (BOOKS.some(([key]) => key === item.book && key !== 'all')) return item.book;
  if (item.category === 'family') return 'me';
  if (item.category === 'animal') return 'creatures';
  return 'discoveries';
}

function showModeMessage(message, duration = 1700) {
  modeMessage.textContent = message;
  modeMessage.classList.add('on');
  clearTimeout(showModeMessage.timer);
  showModeMessage.timer = setTimeout(() => modeMessage.classList.remove('on'), duration);
}

function setStatus(message) { statusEl.textContent = message; }
function objectUrl(blob, bucket = urls) {
  const url = URL.createObjectURL(blob);
  bucket.push(url);
  return url;
}
function revokeAll(bucket) { bucket.splice(0).forEach(URL.revokeObjectURL); }

async function renderGrid() {
  revokeAll(urls);
  const items = await db.all();
  grid.innerHTML = '';
  const filtered = selectedBook === 'all' ? items : items.filter(item => bookOf(item) === selectedBook);
  empty.hidden = items.length > 0;
  childTools.classList.toggle('on', items.length > 0);
  bookShelf.classList.toggle('on', items.length > 0);
  bookShelf.innerHTML = BOOKS.map(([value, label]) => {
    const count = value === 'all' ? items.length : items.filter(item => bookOf(item) === value).length;
    return `<button class="book-tab book-${value}${selectedBook === value ? ' selected' : ''}" data-book="${value}" aria-pressed="${selectedBook === value}"><span>${label}</span><b>${count}</b></button>`;
  }).join('');

  for (const [index, item] of filtered.entries()) {
    const button = document.createElement('button');
    button.className = 'card';
    button.style.setProperty('--index', index);
    button.setAttribute('aria-label', item.name ? `${item.name}の写真` : hasSound(item) ? '写真を見る、声あり' : '写真を見る、声なし');
    const image = document.createElement('img');
    image.src = objectUrl(item.image);
    image.alt = '';
    button.appendChild(image);
    if (item.name?.trim()) {
      const name = document.createElement('span');
      name.className = 'card-name crayon-render';
      name.textContent = item.name;
      button.appendChild(name);
    }
    if (hasSound(item)) {
      const sound = document.createElement('span');
      sound.className = 'sound-badge';
      sound.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 10v4"/><path d="M8 8.5v7"/><path d="M11 6v12"/><path d="M14 9v6"/><path d="M17 7.5v9"/><path d="M20 10.5v3"/></svg>';
      sound.setAttribute('aria-hidden', 'true');
      button.appendChild(sound);
    }
    button.addEventListener('click', () => handleCardTap(item, button, image.src));
    grid.appendChild(button);
  }
}

bookShelf.addEventListener('click', event => {
  const button = event.target.closest('[data-book]');
  if (!button) return;
  selectedBook = button.dataset.book;
  stopSlideshow();
  quizTargetId = null;
  quizModeButton.classList.remove('active');
  renderGrid();
});

function visibleItems(items) {
  return selectedBook === 'all' ? items : items.filter(item => bookOf(item) === selectedBook);
}

function speechSettings(speech) {
  let preset = speech?.preset || 'woman';
  if (preset === 'random') {
    const choices = Object.keys(SPEECH_PRESETS).filter(key => key !== 'random');
    preset = choices[Math.floor(Math.random() * choices.length)];
  }
  const settings = { ...SPEECH_PRESETS[preset], ...(speech || {}), preset };
  settings.rate *= speech?.speed ?? .85;
  return settings;
}

function speakText(text, speech = {}, onEnded = () => {}) {
  if (!('speechSynthesis' in window) || !text?.trim()) { onEnded(); return; }
  const settings = speechSettings(speech);
  const voices = speechSynthesis.getVoices();
  const japanese = voices.filter(voice => /^ja/i.test(voice.lang));
  const voice = japanese[settings.preset === 'man' || settings.preset === 'monster' ? 1 : 0] || japanese[0];
  let remaining = Math.max(1, settings.repeat || 1);
  const next = () => {
    const utterance = new SpeechSynthesisUtterance(text.trim());
    utterance.lang = 'ja-JP';
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    if (voice) utterance.voice = voice;
    utterance.onend = () => { remaining -= 1; remaining ? next() : onEnded(); };
    utterance.onerror = onEnded;
    speechSynthesis.speak(utterance);
  };
  next();
}

async function generateNaturalSpeech(text, preset, speed) {
  let resolvedPreset = preset;
  if (resolvedPreset === 'random') {
    const choices = Object.keys(NATURAL_VOICES);
    resolvedPreset = choices[Math.floor(Math.random() * choices.length)];
  }
  const response = await fetch(NATURAL_SPEECH_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: NATURAL_VOICES[resolvedPreset] || NATURAL_VOICES.woman, speed }),
  });
  if (!response.ok) throw new Error('natural_voice_failed');
  return response.blob();
}

function playItemSound(item, onEnded = () => {}) {
  if (item.soundMode === 'speech' && item.speech?.text) {
    if (item.speech.audio) playVoice(item.speech.audio, DEFAULT_VOICE, onEnded).catch(onEnded);
    else speakText(item.speech.text, item.speech, onEnded);
  } else if (item.audio) {
    playVoice(item.audio, voiceOf(item), onEnded);
  } else if (item.speech?.text) {
    speakText(item.speech.text, item.speech, onEnded);
  } else {
    onEnded();
  }
}

function stopPlayback() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  activeSources.splice(0).forEach(source => { try { source.stop(); } catch (_) {} });
  if (audio) {
    audio.pause();
    audio.src = '';
    audio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
  if (activePlaybackButton) {
    activePlaybackButton.textContent = activePlaybackButton.dataset.idleLabel || '▶ 声を聞く';
    activePlaybackButton.classList.remove('playing-audio');
    activePlaybackButton = null;
  }
  document.querySelectorAll('.card.playing').forEach(card => card.classList.remove('playing'));
}

function celebrate(card) {
  const colors = ['#ffd45c', '#ff7d68', '#79c9e8', '#8ed59c', '#b09be8'];
  for (let index = 0; index < 12; index += 1) {
    const spark = document.createElement('i');
    spark.className = 'spark';
    const angle = (Math.PI * 2 * index) / 7;
    const distance = 35 + (index % 3) * 11;
    spark.style.left = `${45 + (index % 2) * 10}%`;
    spark.style.top = '48%';
    spark.style.setProperty('--spark', colors[index % colors.length]);
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    card.appendChild(spark);
    spark.addEventListener('animationend', () => spark.remove(), { once: true });
  }
}

async function playVoice(blob, settings, onEnded) {
  const voice = { ...DEFAULT_VOICE, ...settings };
  const repeatCount = voice.pattern === 'three' ? 3 : voice.pattern === 'twice' ? 2 : 1;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    await audioContext.resume();
    const buffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    const pitchFactor = 2 ** (voice.pitch / 12);
    const effectiveRate = Math.max(.5, voice.rate * pitchFactor);
    const duration = buffer.duration / effectiveRate;
    const startAt = audioContext.currentTime + .02;
    for (let index = 0; index < repeatCount; index += 1) {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = voice.rate;
      source.detune.value = voice.pitch * 100;
      const gain = audioContext.createGain();
      gain.gain.value = Math.max(.1, Math.min(2, voice.volume));
      let output = source;
      if (voice.effect === 'radio') {
        const highpass = audioContext.createBiquadFilter();
        const lowpass = audioContext.createBiquadFilter();
        highpass.type = 'highpass'; highpass.frequency.value = 650;
        lowpass.type = 'lowpass'; lowpass.frequency.value = 3200;
        source.connect(highpass); highpass.connect(lowpass); output = lowpass;
      }
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.value = -20;
      compressor.knee.value = 12;
      compressor.ratio.value = voice.volume > 1.2 ? 6 : 3;
      output.connect(compressor); compressor.connect(gain); gain.connect(audioContext.destination);
      const scheduledAt = startAt + index * (duration + .22);
      source.start(scheduledAt);
      let echo = null;
      if (voice.effect === 'echo') {
        echo = audioContext.createBufferSource();
        const echoGain = audioContext.createGain();
        echo.buffer = buffer;
        echo.playbackRate.value = voice.rate;
        echo.detune.value = voice.pitch * 100;
        echoGain.gain.value = .28 * Math.min(1.3, voice.volume);
        echo.connect(echoGain); echoGain.connect(audioContext.destination);
        echo.start(scheduledAt + .24);
        activeSources.push(echo);
      }
      activeSources.push(source);
      if (index === repeatCount - 1) (echo || source).onended = onEnded;
    }
  } catch (_) {
    activeAudioUrl = URL.createObjectURL(blob);
    audio = new Audio(activeAudioUrl);
    audio.playbackRate = voice.rate;
    audio.volume = Math.min(1, voice.volume);
    audio.preservesPitch = false;
    audio.play().catch(onEnded);
    audio.onended = onEnded;
  }
}

function play(item, card, src) {
  // iOSの音声制限を満たすため、ユーザーのタップ内でplay()する。
  stopPlayback();
  bigImg.src = src;
  bigName.textContent = item.name || 'なにかな？';
  bigName.classList.add('crayon-render');
  bigName.hidden = false;
  big.classList.add('on');
  card.classList.add('playing');
  celebrate(card);

  if (!hasSound(item)) {
    card.classList.remove('playing');
    return;
  }

  playItemSound(item, () => { card.classList.remove('playing'); stopPlayback(); });
}

function handleCardTap(item, card, src) {
  if (quizTargetId !== null && item.id !== quizTargetId) {
    card.classList.add('quiz-wrong');
    setTimeout(() => card.classList.remove('quiz-wrong'), 500);
    showModeMessage('おしい！ もういちど');
    return;
  }
  if (quizTargetId === item.id) {
    quizTargetId = null;
    showModeMessage('せいかい！');
    play(item, card, src);
    setTimeout(startQuizRound, 2200);
    return;
  }
  play(item, card, src);
}

async function startQuizRound() {
  if (!quizModeButton.classList.contains('active')) return;
  const candidates = visibleItems(await db.all()).filter(item => item.name?.trim());
  if (candidates.length < 2) {
    quizModeButton.classList.remove('active');
    quizTargetId = null;
    showModeMessage('名前つきの写真を2枚以上にしてね', 2600);
    return;
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  quizTargetId = target.id;
  const question = `${target.name}は、どれかな？`;
  showModeMessage(question, 3000);
  speakText(question, { preset: 'woman', rate: .9, pitch: 1.15 });
}

quizModeButton.addEventListener('click', () => {
  stopSlideshow();
  quizModeButton.classList.toggle('active');
  quizTargetId = null;
  if (quizModeButton.classList.contains('active')) startQuizRound();
  else { stopPlayback(); showModeMessage('クイズをおわりました'); }
});

async function runSlideshow() {
  if (!slideshowTimer) return;
  const visible = visibleItems(await db.all());
  const cards = [...grid.querySelectorAll('.card')];
  const candidates = visible.map((item, index) => ({ item, card: cards[index] })).filter(entry => hasSound(entry.item));
  if (!candidates.length || !cards.length) { stopSlideshow(); showModeMessage('声つきの写真を追加してね'); return; }
  const index = slideshowIndex % candidates.length;
  const { item, card } = candidates[index];
  play(item, card, card.querySelector('img').src);
  slideshowIndex += 1;
  slideshowTimer = setTimeout(runSlideshow, 4000);
}

function stopSlideshow() {
  if (slideshowTimer) clearTimeout(slideshowTimer);
  slideshowTimer = null;
  slideModeButton.classList.remove('active');
}

slideModeButton.addEventListener('click', () => {
  if (slideshowTimer) { stopSlideshow(); stopPlayback(); big.classList.remove('on'); showModeMessage('じどう再生をおわりました'); return; }
  quizModeButton.classList.remove('active');
  quizTargetId = null;
  slideshowIndex = 0;
  slideModeButton.classList.add('active');
  slideshowTimer = true;
  runSlideshow();
});

big.addEventListener('click', () => {
  stopSlideshow();
  big.classList.remove('on');
  stopPlayback();
});

// --- 保護者モードへの入口 ---
const parentEntry = document.getElementById('parentEntry');
const adultGate = document.getElementById('adultGate');

try {
  if (localStorage.getItem('talking-album-parent-hint-seen') === '1') {
    parentEntry.classList.add('hint-seen');
  }
} catch (_) { /* localStorageが使えなくても案内は表示する */ }

parentEntry.addEventListener('click', event => {
  event.preventDefault();
  adultGate.classList.add('on');
});
parentEntry.addEventListener('contextmenu', event => event.preventDefault());
document.getElementById('adultGateOpen').addEventListener('click', () => {
  adultGate.classList.remove('on');
  openParent();
});
document.getElementById('adultGateCancel').addEventListener('click', () => adultGate.classList.remove('on'));
adultGate.addEventListener('click', event => {
  if (event.target === adultGate) adultGate.classList.remove('on');
});

function openParent() {
  parentEntry.classList.add('hint-seen');
  try { localStorage.setItem('talking-album-parent-hint-seen', '1'); } catch (_) {}
  stopPlayback();
  stopSlideshow();
  big.classList.remove('on');
  parent.classList.add('on');
  setStatus('');
  renderList().catch(() => setStatus('写真を読み込めませんでした'));
}

document.getElementById('emptyOpen').addEventListener('click', () => {
  openParent();
  document.getElementById('pick').click();
});

document.getElementById('close').addEventListener('click', async () => {
  if (activeRecording) stopRecording();
  parent.classList.remove('on');
  await renderGrid();
});

// --- 写真追加（スマホ写真を保存前に縮小して容量を抑える） ---
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を開けません')); };
    image.src = url;
  });
}

async function prepareImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('画像ではないファイルです');
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
  if (!blob) throw new Error('画像を変換できません');
  return blob;
}

async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) return;
  try { await navigator.storage.persist(); } catch (_) { /* 対応外でも利用は継続 */ }
}

document.getElementById('pick').addEventListener('change', async event => {
  const input = event.target;
  const files = [...input.files];
  input.value = '';
  const existing = await db.all();
  const available = Math.max(0, MAX_ITEMS - existing.length);
  if (!available) {
    setStatus(`写真は${MAX_ITEMS}枚までです`);
    return;
  }

  const selected = files.slice(0, available);
  setStatus(`${selected.length}枚を準備しています…`);
  let added = 0;
  for (const file of selected) {
    try {
      await db.add({
        image: await prepareImage(file), audio: null, name: '', category: 'other',
        book: selectedBook === 'all' ? 'discoveries' : selectedBook,
        discoveredAt: new Date().toISOString().slice(0, 10),
        speech: null, soundMode: 'recording', voice: { ...DEFAULT_VOICE },
      });
      added += 1;
    } catch (_) {
      setStatus('開けない写真がありました');
    }
  }
  await requestPersistentStorage();
  await renderList();
  setStatus(`${added}枚追加しました${files.length > available ? `（上限${MAX_ITEMS}枚）` : ''}`);
});

// --- 親モードの一覧・録音 ---
async function renderList() {
  revokeAll(listUrls);
  const items = await db.all();
  listEl.innerHTML = '';
  parentCount.textContent = `${items.length}枚`;
  updateStorageUsage(items).catch(() => {});

  if (!items.length) {
    const emptyList = document.createElement('div');
    emptyList.className = 'list-empty';
    emptyList.textContent = 'まだ写真がありません。\n「写真を追加」から、まず1枚選んでください。';
    listEl.appendChild(emptyList);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'item';
    const image = document.createElement('img');
    image.src = objectUrl(item.image, listUrls);
    image.alt = '';
    row.appendChild(image);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const fields = document.createElement('div');
    fields.className = 'item-fields';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'item-field';
    nameLabel.innerHTML = '<span>しゃしんの名前</span>';
    const nameInput = document.createElement('input');
    nameInput.className = 'item-name-input';
    nameInput.maxLength = 20;
    nameInput.placeholder = '例：りんご、じいじ';
    nameInput.value = item.name || '';
    nameInput.addEventListener('change', async () => {
      item.name = nameInput.value.trim();
      await db.put(item);
      setStatus('写真の名前を保存しました');
    });
    nameLabel.appendChild(nameInput);
    const bookLabelEl = document.createElement('label');
    bookLabelEl.className = 'item-field';
    bookLabelEl.innerHTML = '<span>入れる図鑑</span>';
    const bookSelectEl = document.createElement('select');
    bookSelectEl.className = 'item-category-select';
    bookSelectEl.innerHTML = BOOKS.filter(([key]) => key !== 'all').map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    bookSelectEl.value = bookOf(item);
    bookSelectEl.addEventListener('change', async () => {
      item.book = bookSelectEl.value;
      await db.put(item);
      setStatus('入れる図鑑を保存しました');
    });
    bookLabelEl.appendChild(bookSelectEl);
    const dateLabelEl = document.createElement('label');
    dateLabelEl.className = 'item-field';
    dateLabelEl.innerHTML = '<span>見つけた日（任意）</span>';
    const dateInput = document.createElement('input');
    dateInput.className = 'item-date-input';
    dateInput.type = 'date';
    dateInput.value = item.discoveredAt || '';
    dateInput.addEventListener('change', async () => {
      item.discoveredAt = dateInput.value;
      await db.put(item);
      setStatus('見つけた日を保存しました');
    });
    dateLabelEl.appendChild(dateInput);
    const categoryLabelEl = document.createElement('label');
    categoryLabelEl.className = 'item-field';
    categoryLabelEl.innerHTML = '<span>グループ</span>';
    const categorySelectEl = document.createElement('select');
    categorySelectEl.className = 'item-category-select';
    categorySelectEl.innerHTML = CATEGORIES.filter(([key]) => key !== 'all').map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    categorySelectEl.value = item.category || 'other';
    categorySelectEl.addEventListener('change', async () => {
      item.category = categorySelectEl.value;
      await db.put(item);
      setStatus('グループを保存しました');
    });
    categoryLabelEl.appendChild(categorySelectEl);
    fields.append(nameLabel, bookLabelEl, categoryLabelEl, dateLabelEl);
    meta.appendChild(fields);
    const voiceState = document.createElement('span');
    voiceState.className = `voice-state${hasSound(item) ? ' has-voice' : ''}`;
    voiceState.textContent = item.soundMode === 'speech' && item.speech?.text ? '文字の声を使用中' : item.audio ? '録音した声を使用中' : item.speech?.text ? '文字の声あり' : '声はまだありません';
    meta.appendChild(voiceState);
    row.appendChild(meta);

    const controls = document.createElement('div');
    controls.className = 'controls';

    if (hasSound(item)) {
      const listen = document.createElement('button');
      listen.textContent = '▶ 声を聞く';
      listen.dataset.idleLabel = '▶ 声を聞く';
      listen.className = 'play-button';
      listen.addEventListener('click', () => toggleItemPlayback(item, listen));
      controls.appendChild(listen);
    }

    if (item.audio) {
      const voicePlay = document.createElement('button');
      voicePlay.textContent = '声をアレンジ';
      voicePlay.className = 'voice-play';
      voicePlay.addEventListener('click', () => openVoiceSheet(item));
      controls.appendChild(voicePlay);
    }

    const record = document.createElement('button');
    record.textContent = item.audio ? '録音し直す' : '声を録音';
    record.addEventListener('click', () => beginRecording(item));
    controls.appendChild(record);

    const speechEdit = document.createElement('button');
    speechEdit.textContent = item.speech?.text ? '読み上げを編集' : '文字から読み上げ';
    speechEdit.className = 'speech-edit';
    speechEdit.addEventListener('click', () => openSpeechSheet(item));
    controls.appendChild(speechEdit);

    if (item.audio) {
      const removeVoice = document.createElement('button');
      removeVoice.textContent = '声だけ削除';
      removeVoice.className = 'voice-remove';
      removeVoice.addEventListener('click', async () => {
        if (!window.confirm('録音した声だけを削除しますか？\n写真は残ります。')) return;
        stopPlayback();
        item.audio = null;
        item.soundMode = item.speech?.text ? 'speech' : '';
        await db.put(item);
        await renderList();
        setStatus('声だけ削除しました。写真は残っています');
      });
      controls.appendChild(removeVoice);
    }

    const removePhoto = document.createElement('button');
    removePhoto.textContent = '写真ごと削除';
    removePhoto.className = 'photo-remove';
    removePhoto.addEventListener('click', async () => {
      if (!window.confirm('この写真を削除しますか？\n録音した声も一緒に削除されます。')) return;
      stopPlayback();
      await db.del(item.id);
      await renderList();
      setStatus('写真と声を削除しました');
    });
    controls.appendChild(removePhoto);
    row.appendChild(controls);
    listEl.appendChild(row);
  }
}

function togglePlayback(blob, button, settings = DEFAULT_VOICE) {
  if (!blob) return;
  if (activePlaybackButton === button && ((audio && !audio.paused) || activeSources.length)) {
    stopPlayback();
    return;
  }
  stopPlayback();
  activePlaybackButton = button;
  button.textContent = '■ 停止';
  button.classList.add('playing-audio');
  playVoice(blob, settings, stopPlayback).catch(() => {
    stopPlayback();
    setStatus('声を再生できませんでした');
  });
}

function toggleItemPlayback(item, button) {
  if (activePlaybackButton === button) { stopPlayback(); return; }
  stopPlayback();
  activePlaybackButton = button;
  button.textContent = '■ 停止';
  button.classList.add('playing-audio');
  playItemSound(item, stopPlayback);
}

// --- 声の高さ・速さ・再生パターン ---
const voiceSheet = document.getElementById('voiceSheet');
const voicePitch = document.getElementById('voicePitch');
const voiceRate = document.getElementById('voiceRate');
const voiceVolume = document.getElementById('voiceVolume');
const voicePitchValue = document.getElementById('voicePitchValue');
const voiceRateValue = document.getElementById('voiceRateValue');
const voiceVolumeValue = document.getElementById('voiceVolumeValue');
const voiceTry = document.getElementById('voiceTry');
const voiceSave = document.getElementById('voiceSave');
const voiceCancel = document.getElementById('voiceCancel');
let voiceEditingItem = null;
let voiceDraft = { ...DEFAULT_VOICE };

const VOICE_PRESETS = {
  normal: { rate: 1, pitch: 0, volume: 1, effect: 'clean', pattern: 'once' },
  high: { rate: 1.18, pitch: 4, volume: 1, effect: 'clean', pattern: 'once' },
  low: { rate: .78, pitch: -4, volume: 1.05, effect: 'clean', pattern: 'once' },
  loud: { rate: 1, pitch: 0, volume: 1.7, effect: 'clean', pattern: 'once' },
  radio: { rate: 1.02, pitch: 0, volume: 1.15, effect: 'radio', pattern: 'once' },
  echo: { rate: .95, pitch: 0, volume: 1, effect: 'echo', pattern: 'once' },
};

function pitchLabel(value) {
  const number = Number(value);
  return number === 0 ? 'ふつう' : number > 0 ? `高め +${number}` : `低め ${number}`;
}

function rateLabel(value) {
  const number = Number(value);
  if (Math.abs(number - 1) < .01) return 'ふつう';
  return number > 1 ? `はやめ ×${number.toFixed(2)}` : `ゆっくり ×${number.toFixed(2)}`;
}

function volumeLabel(value) {
  const number = Number(value);
  if (number >= 1.5) return 'かなり大きい';
  if (number > 1.05) return '大きめ';
  if (number < .95) return '小さめ';
  return 'ふつう';
}

function renderVoiceControls() {
  voicePitch.value = voiceDraft.pitch;
  voiceRate.value = voiceDraft.rate;
  voiceVolume.value = voiceDraft.volume ?? 1;
  voicePitchValue.textContent = pitchLabel(voiceDraft.pitch);
  voiceRateValue.textContent = rateLabel(voiceDraft.rate);
  voiceVolumeValue.textContent = volumeLabel(voiceDraft.volume ?? 1);
  document.querySelectorAll('.preset').forEach(button => {
    button.classList.toggle('selected', button.dataset.preset === voiceDraft.preset);
  });
  document.querySelectorAll('.pattern').forEach(button => {
    button.classList.toggle('selected', button.dataset.pattern === voiceDraft.pattern);
  });
}

function openVoiceSheet(item) {
  stopPlayback();
  voiceEditingItem = item;
  voiceDraft = voiceOf(item);
  renderVoiceControls();
  voiceSheet.classList.add('on');
}

function closeVoiceSheet() {
  stopPlayback();
  voiceSheet.classList.remove('on');
  voiceEditingItem = null;
}

document.querySelectorAll('.preset').forEach(button => button.addEventListener('click', () => {
  const preset = button.dataset.preset;
  voiceDraft = { ...voiceDraft, ...VOICE_PRESETS[preset], preset };
  renderVoiceControls();
}));

document.querySelectorAll('.pattern').forEach(button => button.addEventListener('click', () => {
  voiceDraft.pattern = button.dataset.pattern;
  voiceDraft.preset = 'custom';
  renderVoiceControls();
}));

voicePitch.addEventListener('input', () => {
  voiceDraft.pitch = Number(voicePitch.value);
  voiceDraft.preset = 'custom';
  renderVoiceControls();
});

voiceRate.addEventListener('input', () => {
  voiceDraft.rate = Number(voiceRate.value);
  voiceDraft.preset = 'custom';
  renderVoiceControls();
});

voiceVolume.addEventListener('input', () => {
  voiceDraft.volume = Number(voiceVolume.value);
  voiceDraft.preset = 'custom';
  renderVoiceControls();
});

voiceTry.addEventListener('click', () => {
  if (!voiceEditingItem?.audio) return;
  voiceTry.dataset.idleLabel = '▶ ためす';
  togglePlayback(voiceEditingItem.audio, voiceTry, voiceDraft);
});

voiceSave.addEventListener('click', async () => {
  if (!voiceEditingItem) return;
  voiceEditingItem.voice = { ...voiceDraft };
  await db.put(voiceEditingItem);
  closeVoiceSheet();
  await renderList();
  setStatus('声のあそびを保存しました');
});

voiceCancel.addEventListener('click', closeVoiceSheet);

// --- 文字から読み上げる声 ---
const speechSheet = document.getElementById('speechSheet');
const speechText = document.getElementById('speechText');
const speechCategory = document.getElementById('speechCategory');
const speechSpeed = document.getElementById('speechSpeed');
const speechSpeedValue = document.getElementById('speechSpeedValue');
const speechTry = document.getElementById('speechTry');
const speechSave = document.getElementById('speechSave');
const speechRemove = document.getElementById('speechRemove');
const speechCancel = document.getElementById('speechCancel');
let speechEditingItem = null;
let speechPreset = 'woman';
let speechSpeedDraft = .85;

function speechSpeedLabel(value) {
  const speed = Number(value);
  if (speed <= .65) return 'とてもゆっくり';
  if (speed <= .8) return 'ゆっくり';
  if (speed <= .95) return 'ふつう';
  return 'はやめ';
}

function renderSpeechPreset() {
  document.querySelectorAll('.speech-preset').forEach(button => button.classList.toggle('selected', button.dataset.speechPreset === speechPreset));
}

function openSpeechSheet(item) {
  stopPlayback();
  speechEditingItem = item;
  speechText.value = item.speech?.text || item.name || '';
  speechCategory.innerHTML = CATEGORIES.filter(([key]) => key !== 'all').map(([value,label]) => `<option value="${value}">${label}</option>`).join('');
  speechCategory.value = item.category || 'other';
  speechPreset = item.speech?.preset || 'woman';
  speechSpeedDraft = Number(item.speech?.speed ?? .85);
  speechSpeed.value = speechSpeedDraft;
  speechSpeedValue.textContent = speechSpeedLabel(speechSpeedDraft);
  renderSpeechPreset();
  speechSheet.classList.add('on');
}

function closeSpeechSheet() {
  stopPlayback();
  speechSheet.classList.remove('on');
  speechEditingItem = null;
}

document.querySelectorAll('.speech-preset').forEach(button => button.addEventListener('click', () => {
  speechPreset = button.dataset.speechPreset;
  renderSpeechPreset();
}));

speechSpeed.addEventListener('input', () => {
  speechSpeedDraft = Number(speechSpeed.value);
  speechSpeedValue.textContent = speechSpeedLabel(speechSpeedDraft);
});

speechTry.addEventListener('click', async () => {
  const text = speechText.value.trim();
  if (!text) { setStatus('読み上げることばを入力してください'); return; }
  stopPlayback();
  speechTry.disabled = true;
  speechTry.textContent = '声をつくっています…';
  setStatus('自然な声をつくっています…');
  try {
    const blob = await generateNaturalSpeech(text, speechPreset, speechSpeedDraft);
    speechTry.disabled = false;
    speechTry.dataset.idleLabel = '▶ ためす';
    speechTry.textContent = '▶ ためす';
    togglePlayback(blob, speechTry);
    setStatus('自然な声を再生しています');
  } catch (_) {
    speechTry.disabled = false;
    speechTry.textContent = '▶ ためす';
    speakText(text, { preset: speechPreset, speed: speechSpeedDraft });
    setStatus('通信できないため、iPhoneの声で再生しています');
  }
});

speechSave.addEventListener('click', async () => {
  if (!speechEditingItem) return;
  const text = speechText.value.trim();
  if (!text) { setStatus('読み上げることばを入力してください'); speechText.focus(); return; }
  speechSave.disabled = true;
  speechSave.textContent = '声をつくっています…';
  setStatus('自然な声をつくって端末に保存しています…');
  let generatedAudio = null;
  try {
    generatedAudio = await generateNaturalSpeech(text, speechPreset, speechSpeedDraft);
  } catch (_) {
    setStatus('通信できないため、iPhoneの読み上げ音声として保存します');
  }
  if (!speechEditingItem.name?.trim()) speechEditingItem.name = text.replace(/[、。！？!?]/g, '').slice(0, 20);
  speechEditingItem.category = speechCategory.value;
  speechEditingItem.speech = { text, preset: speechPreset, speed: speechSpeedDraft, audio: generatedAudio };
  speechEditingItem.soundMode = 'speech';
  await db.put(speechEditingItem);
  speechSave.disabled = false;
  speechSave.textContent = 'これにする';
  closeSpeechSheet();
  await renderList();
  setStatus(generatedAudio ? '自然な声をこのiPhoneに保存しました' : '文字の声を保存しました');
});

speechRemove.addEventListener('click', async () => {
  if (!speechEditingItem?.speech) { closeSpeechSheet(); return; }
  if (!window.confirm('文字から作った声を削除しますか？')) return;
  speechEditingItem.speech = null;
  speechEditingItem.soundMode = speechEditingItem.audio ? 'recording' : '';
  await db.put(speechEditingItem);
  closeSpeechSheet();
  await renderList();
  setStatus('文字の声を削除しました');
});

speechCancel.addEventListener('click', closeSpeechSheet);

function pickMime() {
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  for (const mime of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

const recordingSheet = document.getElementById('recordingSheet');
const recordingLabel = document.getElementById('recordingLabel');
const recordingTitle = document.getElementById('recordingTitle');
const recordingTimer = document.getElementById('recordingTimer');
const recordStop = document.getElementById('recordStop');
const recordPreview = document.getElementById('recordPreview');
const recordRetry = document.getElementById('recordRetry');
const recordSave = document.getElementById('recordSave');
const recordCancel = document.getElementById('recordCancel');
let activeRecording = null;
let recordingDraft = null;

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  return `00:${String(seconds).padStart(2, '0')}`;
}

function closeRecordingSheet() {
  stopPlayback();
  recordingSheet.classList.remove('on', 'recording', 'review');
  recordingDraft = null;
}

function stopRecording() {
  if (activeRecording && activeRecording.recorder.state !== 'inactive') {
    activeRecording.recorder.stop();
  }
}

async function beginRecording(item) {
  if (activeRecording) return;
  stopPlayback();
  recordingDraft = null;
  if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
    setStatus('このスマホでは録音機能を使えません');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    setStatus('マイクを使えません。Safariの設定で許可してください');
    return;
  }

  const mime = pickMime();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (_) {
    stream.getTracks().forEach(track => track.stop());
    setStatus('録音を開始できませんでした');
    return;
  }

  const chunks = [];
  const startedAt = Date.now();
  recordingLabel.textContent = '録音中';
  recordingTitle.textContent = '名前を話してください';
  recordingTimer.textContent = '00:00';
  recordingSheet.classList.remove('review');
  recordingSheet.classList.add('on', 'recording');
  const ticker = setInterval(() => {
    recordingTimer.textContent = formatDuration(Date.now() - startedAt);
  }, 200);
  const timeout = setTimeout(() => stopRecording(), RECORDING_LIMIT_MS);
  activeRecording = { recorder, stream, item, chunks, timeout, ticker, startedAt, discard: false };

  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = () => {
    setStatus('録音中にエラーが起きました');
  };
  recorder.onstop = async () => {
    clearTimeout(timeout);
    clearInterval(ticker);
    stream.getTracks().forEach(track => track.stop());
    const shouldDiscard = activeRecording?.discard;
    recordingTimer.textContent = formatDuration(Date.now() - startedAt);
    activeRecording = null;
    if (shouldDiscard) {
      closeRecordingSheet();
      return;
    }
    if (!chunks.length) {
      closeRecordingSheet();
      setStatus('声を録音できませんでした。もう一度お試しください');
      return;
    }
    recordingDraft = { item, blob: new Blob(chunks, { type: recorder.mimeType || 'audio/mp4' }) };
    recordingLabel.textContent = '録音できました';
    recordingTitle.textContent = '声を確認してください';
    recordPreview.textContent = '▶ 声を聞く';
    recordPreview.dataset.idleLabel = '▶ 声を聞く';
    recordingSheet.classList.remove('recording');
    recordingSheet.classList.add('review');
  };
  recorder.start();
}

recordStop.addEventListener('click', stopRecording);
recordPreview.addEventListener('click', () => {
  if (recordingDraft) togglePlayback(recordingDraft.blob, recordPreview);
});
recordRetry.addEventListener('click', () => {
  if (!recordingDraft) return;
  const item = recordingDraft.item;
  closeRecordingSheet();
  beginRecording(item);
});
recordSave.addEventListener('click', async () => {
  if (!recordingDraft) return;
  recordingDraft.item.audio = recordingDraft.blob;
  recordingDraft.item.soundMode = 'recording';
  await db.put(recordingDraft.item);
  closeRecordingSheet();
  await renderList();
  setStatus('声を保存しました。「声を聞く」で確認できます');
});
recordCancel.addEventListener('click', () => {
  if (activeRecording) {
    activeRecording.discard = true;
    stopRecording();
  } else {
    closeRecordingSheet();
  }
});

// --- 端末内データのバックアップ／復元 ---
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(value) {
  if (typeof value !== 'string' || !value.startsWith('data:')) throw new Error('不正なデータです');
  return (await fetch(value)).blob();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

async function updateStorageUsage(items = null) {
  const usageEl = document.getElementById('storageUsage');
  if (!usageEl) return;
  const records = items || await db.all();
  const mediaBytes = records.reduce((total, item) => total + (item.image?.size || 0) + (item.audio?.size || 0) + (item.speech?.audio?.size || 0), 0);
  const estimate = await navigator.storage?.estimate?.();
  const quotaText = estimate?.quota ? `／利用可能な目安 ${formatBytes(estimate.quota)}` : '';
  usageEl.textContent = `使用中 約${formatBytes(mediaBytes)}${quotaText}`;
}

document.getElementById('backup').addEventListener('click', async () => {
  const items = await db.all();
  if (!items.length) {
    setStatus('バックアップする写真がありません');
    return;
  }
  setStatus('バックアップを作っています…');
  const records = [];
  for (const item of items) {
    records.push({
      image: await blobToDataUrl(item.image),
      audio: item.audio ? await blobToDataUrl(item.audio) : null,
      name: item.name || '',
      category: item.category || 'other',
      book: bookOf(item),
      discoveredAt: item.discoveredAt || '',
      speech: item.speech || null,
      speechAudio: item.speech?.audio ? await blobToDataUrl(item.speech.audio) : null,
      soundMode: item.soundMode || (item.audio ? 'recording' : item.speech?.text ? 'speech' : ''),
      voice: voiceOf(item),
    });
  }
  const payload = JSON.stringify({ app: 'talking-album', version: 4, createdAt: new Date().toISOString(), items: records });
  const file = new File([payload], `zukan-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ title: 'ずかんのバックアップ', files: [file] });
      setStatus('バックアップを共有しました');
      return;
    } catch (error) {
      if (error.name === 'AbortError') { setStatus('バックアップを中止しました'); return; }
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('バックアップを保存しました');
});

document.getElementById('restore').addEventListener('change', async event => {
  const input = event.target;
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (!window.confirm('今ある写真と声を、バックアップの内容に置き換えますか？')) return;
  setStatus('バックアップを確認しています…');
  try {
    const payload = JSON.parse(await file.text());
    if (payload.app !== 'talking-album' || ![1, 2, 3, 4].includes(payload.version) || !Array.isArray(payload.items)) {
      throw new Error('このアプリのバックアップではありません');
    }
    if (payload.items.length > MAX_ITEMS) throw new Error(`写真は${MAX_ITEMS}枚までです`);
    const restored = [];
    for (const item of payload.items) {
      restored.push({
        image: await dataUrlToBlob(item.image),
        audio: item.audio ? await dataUrlToBlob(item.audio) : null,
        name: typeof item.name === 'string' ? item.name : '',
        category: CATEGORIES.some(([key]) => key === item.category) ? item.category : 'other',
        book: BOOKS.some(([key]) => key === item.book && key !== 'all') ? item.book : undefined,
        discoveredAt: typeof item.discoveredAt === 'string' ? item.discoveredAt : '',
        speech: item.speech?.text ? { text: String(item.speech.text).slice(0, 80), preset: SPEECH_PRESETS[item.speech.preset] ? item.speech.preset : 'woman', speed: Math.min(1.15, Math.max(.55, Number(item.speech.speed ?? .85))), audio: item.speechAudio ? await dataUrlToBlob(item.speechAudio) : null } : null,
        soundMode: item.soundMode === 'speech' ? 'speech' : 'recording',
        voice: item.voice && typeof item.voice === 'object' ? { ...DEFAULT_VOICE, ...item.voice } : { ...DEFAULT_VOICE },
      });
    }
    await db.clear();
    for (const item of restored) await db.add(item);
    await requestPersistentStorage();
    await renderList();
    setStatus(`${restored.length}枚をもどしました`);
  } catch (error) {
    setStatus(error.message || 'バックアップをもどせませんでした');
  }
});

// --- 起動 ---
renderGrid().catch(() => {
  empty.hidden = false;
  empty.textContent = '写真を読み込めませんでした。ページを開き直してください。';
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
