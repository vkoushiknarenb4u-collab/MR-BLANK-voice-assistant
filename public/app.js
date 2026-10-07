const micButton = document.querySelector('#mic-button');
const micHint = document.querySelector('#mic-hint');
const statusLine = document.querySelector('#status-line');
const statusText = document.querySelector('#status-text');
const messagesElement = document.querySelector('#messages');
const welcomeCard = document.querySelector('#welcome-card');
const clearButton = document.querySelector('#clear-button');
const muteButton = document.querySelector('#mute-button');
const keyButton = document.querySelector('#key-button');
const keyDialog = document.querySelector('#key-dialog');
const closeKeyDialog = document.querySelector('#close-key-dialog');
const textForm = document.querySelector('#text-form');
const textInput = document.querySelector('#text-input');
const sendButton = document.querySelector('#send-button');
const connection = document.querySelector('.connection');
const connectionLabel = document.querySelector('#connection-label');
const toast = document.querySelector('#toast');
const historyList = document.querySelector('#history-list');
const typeButton = document.querySelector('#type-button');
const speakButton = document.querySelector('#speak-button');
const recentClearButton = document.querySelector('#clear-recent');
const headerKeyButton = document.querySelector('.header-settings');

const conversation = [];
let mediaRecorder = null;
let mediaStream = null;
let recordingChunks = [];
let recordingTimeout = null;
let busy = false;
let listening = false;
let muted = false;
let toastTimer;

function setStatus(text, mode = 'ready') {
  statusText.textContent = text;
  statusLine.className = `status-line ${mode}`;
}

function showError(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5200);
  setStatus('Ready when you are');
}

function addMessage(role, text) {
  welcomeCard.hidden = true;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  article.dataset.conversationIndex = String(conversation.length - 1);
  const label = document.createElement('p');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'YOU' : 'MR BLANK';
  const bubble = document.createElement('p');
  bubble.className = 'message-bubble';
  bubble.textContent = text;
  article.append(label, bubble);
  messagesElement.append(article);
  messagesElement.scrollTop = messagesElement.scrollHeight;
  clearButton.disabled = false;
}

function renderHistory() {
  if (!historyList) return;
  historyList.replaceChildren();
  const recent = conversation
    .map((message, index) => ({ ...message, index }))
    .filter((message) => message.role === 'user')
    .slice(-3)
    .reverse();

  if (!recent.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-history';
    empty.textContent = 'Your recent messages will appear here.';
    historyList.append(empty);
    return;
  }

  for (const item of recent) {
    const row = document.createElement('button');
    row.className = 'recent-row';
    row.type = 'button';
    row.innerHTML = '<span class="recent-bubble-icon" aria-hidden="true">▤</span><span class="recent-copy"><strong></strong><small>This session</small></span><span class="recent-arrow" aria-hidden="true">›</span>';
    row.querySelector('strong').textContent = item.text;
    row.addEventListener('click', () => {
      const message = messagesElement.querySelector(`[data-conversation-index="${item.index}"]`);
      message?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    historyList.append(row);
  }
}

function updateClock() {
  const now = new Date();
  const dateElement = document.querySelector('#today-date');
  const timeElement = document.querySelector('#live-time');
  if (dateElement) dateElement.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(now);
  if (timeElement) timeElement.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(now);
}

function updateControls() {
  micButton.disabled = busy;
  textInput.disabled = busy || listening;
  sendButton.disabled = busy || listening || textInput.value.trim().length === 0;
}

async function checkServer() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (data.ready) {
      connection.className = 'connection ready';
      connectionLabel.textContent = 'Gemini configured';
    } else {
      connection.className = 'connection error';
      connectionLabel.textContent = 'Add API key';
    }
  } catch {
    connection.className = 'connection error';
    connectionLabel.textContent = 'Server unavailable';
  }
}

function speak(text) {
  if (muted || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ta-IN';
  utterance.rate = 0.94;
  const voices = window.speechSynthesis.getVoices();
  const tamilVoice = voices.find((voice) => voice.lang.toLowerCase().startsWith('ta'));
  if (tamilVoice) utterance.voice = tamilVoice;
  utterance.onstart = () => setStatus('MR BLANK is speaking…', 'speaking');
  utterance.onend = () => setStatus('Ready when you are');
  utterance.onerror = () => setStatus('Ready when you are');
  window.speechSynthesis.speak(utterance);
}

async function sendToAssistant(text) {
  const message = text.trim();
  if (!message || busy) {
    if (!message) showError('I didn’t catch that. Please try speaking again.');
    return;
  }

  conversation.push({ role: 'user', text: message });
  addMessage('user', message);
  renderHistory();
  busy = true;
  setStatus('Thinking…', 'thinking');
  updateControls();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: conversation.slice(-20) })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'I couldn’t get a reply just now. Please try again.');
    conversation.push({ role: 'assistant', text: data.text });
    addMessage('assistant', data.text);
    setStatus('Ready when you are');
    speak(data.text);
  } catch (error) {
    conversation.pop();
    renderHistory();
    showError(error.message || 'I couldn’t reach Gemini. Please check your connection and try again.');
  } finally {
    busy = false;
    updateControls();
  }
}

async function transcribeRecording(blob) {
  busy = true;
  micHint.textContent = 'Transcribing your speech…';
  setStatus('Transcribing…', 'thinking');
  updateControls();
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'I couldn’t transcribe that. Please try again.');
    const transcript = data.text?.trim();
    if (!transcript) throw new Error('I didn’t catch any speech. Please try again.');

    busy = false;
    updateControls();
    await sendToAssistant(transcript);
  } catch (error) {
    showError(error.message || 'I couldn’t transcribe that recording. Please try again.');
  } finally {
    busy = false;
    micHint.textContent = 'Tap the mic and speak in Tamil, Tanglish, or English';
    updateControls();
  }
}

async function startListening() {
  if (listening && mediaRecorder?.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (busy) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError('Microphone recording is not supported in this browser. Open MR BLANK in Chrome or Edge.');
    return;
  }

  busy = true;
  setStatus('Requesting microphone…', 'thinking');
  updateControls();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const supportedTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = supportedTypes.find((type) => MediaRecorder.isTypeSupported(type));
    mediaRecorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    mediaStream = stream;
    recordingChunks = [];
    let recordingFailed = false;
    const activeRecorder = mediaRecorder;

    activeRecorder.ondataavailable = (event) => {
      if (event.data?.size) recordingChunks.push(event.data);
    };
    activeRecorder.onerror = () => {
      recordingFailed = true;
      showError('The microphone recording stopped unexpectedly. Please try again.');
      if (activeRecorder.state !== 'inactive') activeRecorder.stop();
    };
    activeRecorder.onstop = () => {
      clearTimeout(recordingTimeout);
      mediaStream?.getTracks().forEach((track) => track.stop());
      mediaStream = null;
      mediaRecorder = null;
      listening = false;
      micButton.classList.remove('listening');
      micButton.setAttribute('aria-label', 'Start speaking');
      if (!recordingFailed) {
        const blob = new Blob(recordingChunks, { type: activeRecorder.mimeType || 'audio/webm' });
        if (blob.size) void transcribeRecording(blob);
        else showError('I didn’t hear anything. Please try again.');
      }
      recordingChunks = [];
      updateControls();
    };

    activeRecorder.start(250);
    listening = true;
    busy = false;
    micButton.classList.add('listening');
    micButton.setAttribute('aria-label', 'Stop listening');
    micHint.textContent = 'Listening… tap the mic when you’re done';
    setStatus('Listening…', 'listening');
    updateControls();
    recordingTimeout = setTimeout(() => {
      if (mediaRecorder === activeRecorder && activeRecorder.state === 'recording') activeRecorder.stop();
    }, 45000);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    mediaRecorder = null;
    listening = false;
    busy = false;
    micButton.classList.remove('listening');
    micButton.setAttribute('aria-label', 'Start speaking');
    const permissionErrors = {
      NotAllowedError: 'Microphone access is blocked. Allow it in your browser’s site settings, then try again.',
      SecurityError: 'Microphone access is blocked. Open MR BLANK at http://localhost:3000 and allow microphone access.',
      NotFoundError: 'No microphone was found. Connect one or type your message instead.',
      NotReadableError: 'The microphone is busy in another app. Close that app and try again.'
    };
    showError(permissionErrors[error.name] || 'The microphone could not start. Check its permission and try again.');
    updateControls();
  }
}

micButton.addEventListener('click', startListening);
speakButton.addEventListener('click', startListening);
typeButton.addEventListener('click', () => textInput.focus());
muteButton.addEventListener('click', () => {
  muted = !muted;
  muteButton.classList.toggle('muted', muted);
  muteButton.setAttribute('aria-label', muted ? 'Unmute voice replies' : 'Mute voice replies');
  muteButton.title = muted ? 'Unmute voice replies' : 'Mute voice replies';
  if (muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
});

keyButton.addEventListener('click', () => keyDialog.showModal());
headerKeyButton?.addEventListener('click', () => keyDialog.showModal());
closeKeyDialog.addEventListener('click', () => keyDialog.close());

clearButton.addEventListener('click', () => {
  if (busy) return;
  conversation.length = 0;
  renderHistory();
  messagesElement.querySelectorAll('.message').forEach((message) => message.remove());
  welcomeCard.hidden = false;
  clearButton.disabled = true;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  setStatus('Ready when you are');
});

recentClearButton?.addEventListener('click', () => clearButton.click());

document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    const prompt = button.dataset.prompt || '';
    textInput.value = prompt;
    updateControls();
    textInput.focus();
    if (!button.hasAttribute('data-fill-only')) textForm.requestSubmit();
  });
});

document.querySelectorAll('[data-scroll-target]').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.side-nav .nav-item').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  });
});

textInput.addEventListener('input', updateControls);
textForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = textInput.value.trim();
  if (!message || busy) return;
  textInput.value = '';
  updateControls();
  sendToAssistant(message);
});

checkServer();
updateClock();
setInterval(updateClock, 30000);
const keySetupResult = new URLSearchParams(window.location.search).get('key');
if (keySetupResult === 'saved') {
  setStatus('API key saved on this computer');
  window.history.replaceState(null, '', window.location.pathname);
  setTimeout(() => setStatus('Ready when you are'), 3200);
} else if (keySetupResult === 'invalid') {
  showError('Paste a valid API key before saving.');
  window.history.replaceState(null, '', window.location.pathname);
} else if (keySetupResult === 'save-error') {
  showError('I couldn’t save the key. Check that this folder is writable and try again.');
  window.history.replaceState(null, '', window.location.pathname);
}
