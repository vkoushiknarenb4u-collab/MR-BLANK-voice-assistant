import { createServer } from 'node:http';
import { readFile, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const maxBodyBytes = 64 * 1024;
const maxAudioBytes = 8 * 1024 * 1024;

// Load simple KEY=value entries without a runtime dependency. Existing shell env wins.
try {
  const envFile = readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
      process.env[match[1]] = value;
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const port = Number(process.env.PORT) || 3000;
const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function readJson(req, res) {
  return new Promise((resolve, reject) => {
    let body = '';
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return;
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > maxBodyBytes) {
        oversized = true;
        sendJson(res, 413, { error: 'That message is too long. Please shorten it and try again.' });
        req.resume();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (oversized) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

function readForm(req, res) {
  return new Promise((resolve, reject) => {
    let body = '';
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return;
      body += chunk.toString('utf8');
      if (Buffer.byteLength(body) > maxBodyBytes) {
        oversized = true;
        sendJson(res, 413, { error: 'That form is too large.' });
        req.resume();
        resolve(null);
      }
    });
    req.on('end', () => {
      if (oversized) return;
      resolve(new URLSearchParams(body));
    });
    req.on('error', reject);
  });
}

function readAudio(req, res) {
  const requestedType = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  const supportedTypes = new Set([
    'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/m4a', 'audio/aac',
    'audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/opus'
  ]);
  if (!supportedTypes.has(requestedType)) {
    sendJson(res, 415, { error: 'This browser’s recording format is not supported. Try Chrome or Edge.' });
    req.resume();
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on('data', (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > maxAudioBytes) {
        oversized = true;
        sendJson(res, 413, { error: 'That recording is too long. Please try a shorter message.' });
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) return;
      resolve({ audio: Buffer.concat(chunks), mimeType: requestedType });
    });
    req.on('error', reject);
  });
}

function isLocalSettingsRequest(req) {
  const host = req.headers.host || '';
  try {
    const parsedHost = new URL(`http://${host}`);
    const localHost = ['localhost', '127.0.0.1'].includes(parsedHost.hostname);
    const sameOrigin = req.headers.origin === `http://${host}` ||
      (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin');
    return localHost && sameOrigin;
  } catch {
    return false;
  }
}

async function handleKeySetup(req, res) {
  if (!isLocalSettingsRequest(req)) {
    return sendJson(res, 403, { error: 'Open MR BLANK on this computer to update its API key.' });
  }

  let form;
  try {
    form = await readForm(req, res);
  } catch {
    return sendJson(res, 400, { error: 'I couldn’t read that API key. Please try again.' });
  }
  if (form === null) return;

  const apiKey = (form.get('apiKey') || '').trim();
  if (!apiKey || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) {
    res.writeHead(303, { location: '/?key=invalid', 'cache-control': 'no-store' }).end();
    return;
  }

  let existing = '';
  try {
    existing = readFileSync(path.join(root, '.env'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      res.writeHead(303, { location: '/?key=save-error', 'cache-control': 'no-store' }).end();
      return;
    }
  }
  const otherSettings = existing.split(/\r?\n/).filter((line) => !/^\s*GEMINI_API_KEY\s*=/.test(line));
  otherSettings.unshift(`GEMINI_API_KEY=${apiKey}`);
  try {
    writeFileSync(path.join(root, '.env'), `${otherSettings.join('\n').replace(/\n+$/, '')}\n`, { encoding: 'utf8', mode: 0o600 });
    process.env.GEMINI_API_KEY = apiKey;
  } catch (error) {
    console.error('Could not save the Gemini API key:', error?.message || error);
    res.writeHead(303, { location: '/?key=save-error', 'cache-control': 'no-store' }).end();
    return;
  }
  res.writeHead(303, { location: '/?key=saved', 'cache-control': 'no-store' }).end();
}

async function handleChat(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return sendJson(res, 503, { error: 'Gemini API key is not saved yet. Click API key, paste it, and save.' });
  }

  let input;
  try {
    input = await readJson(req, res);
  } catch {
    return sendJson(res, 400, { error: 'I couldn’t read that message. Please try again.' });
  }
  if (input === null) return;

  const messages = input?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, { error: 'Say or type a message first.' });
  }
  const context = messages.slice(-20);
  const validMessages = context.every((message) =>
    message && ['user', 'assistant'].includes(message.role) &&
    typeof message.text === 'string' && message.text.trim().length > 0 && message.text.length <= 4000
  );
  if (!validMessages || context.at(-1)?.role !== 'user') {
    return sendJson(res, 400, { error: 'That conversation could not be sent. Please try again.' });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: [
            'You are MR BLANK, a friendly, intelligent, concise personal assistant.',
            'Understand Tamil, English, and Tanglish (Tamil written in Latin letters).',
            'Reply in natural Tamil when the user speaks Tamil. When they use Tanglish, understand it and reply naturally in Tamil or in a similar casual style.',
            'Keep answers brief unless the user asks for detail. Do not claim you have set reminders, accessed devices, or completed actions you cannot actually perform.',
            'Use the conversation history to maintain context.'
          ].join(' ') }]
        },
        contents: context.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.text.trim() }]
        })),
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error(`Gemini returned HTTP ${response.status}:`, data?.error?.message || 'request failed');
      const message = response.status === 401 || response.status === 403
        ? 'Gemini rejected the API key. Check the key in your .env file.'
        : response.status === 429
          ? 'Gemini is busy right now. Please wait a moment and try again.'
          : 'Gemini is having trouble right now. Please try again in a moment.';
      return sendJson(res, 502, { error: message });
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();
    if (!text) return sendJson(res, 502, { error: 'I couldn’t form a reply just now. Please try again.' });
    return sendJson(res, 200, { text });
  } catch (error) {
    console.error('Gemini request failed:', error?.message || error);
    const message = error?.name === 'TimeoutError'
      ? 'Gemini took too long to reply. Please try again.'
      : 'I couldn’t reach Gemini. Check your internet connection and try again.';
    return sendJson(res, 502, { error: message });
  }
}

async function handleTranscription(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return sendJson(res, 503, { error: 'Gemini API key is not saved yet. Click API key, paste it, and save.' });
  }

  let recording;
  try {
    recording = await readAudio(req, res);
  } catch {
    return sendJson(res, 400, { error: 'I couldn’t read the recording. Please try again.' });
  }
  if (recording === null) return;
  if (!recording.audio.length) return sendJson(res, 400, { error: 'I didn’t hear anything. Please try again.' });

  const mimeType = recording.mimeType === 'audio/mp4' ? 'audio/m4a' : recording.mimeType;
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      signal: AbortSignal.timeout(45000),
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: 'Transcribe the speech in this audio verbatim. It may be Tamil, English, or Tanglish, and it may switch languages. Return only the spoken words. Do not answer or summarize the speech.' },
            { inlineData: { mimeType, data: recording.audio.toString('base64') } }
          ]
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 256 }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error(`Gemini transcription returned HTTP ${response.status}:`, data?.error?.message || 'request failed');
      const message = response.status === 401 || response.status === 403
        ? 'Gemini rejected the API key. Check the key in your .env file.'
        : response.status === 429 || response.status === 503
          ? 'Gemini transcription is busy right now. Please wait a moment and try again.'
          : 'I couldn’t transcribe that recording. Please try again.';
      return sendJson(res, 502, { error: message });
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || '')
      .join('')
      .trim();
    if (!text || text === 'EMPTY_AUDIO' || /^(?:\d{1,2}:){1,2}\d{2}$/.test(text)) {
      return sendJson(res, 422, { error: 'I didn’t catch any speech. Please try again.' });
    }
    return sendJson(res, 200, { text });
  } catch (error) {
    console.error('Gemini transcription request failed:', error?.message || error);
    const message = error?.name === 'TimeoutError'
      ? 'Transcription took too long. Please try a shorter recording.'
      : 'I couldn’t reach Gemini to transcribe that recording. Check your connection and try again.';
    return sendJson(res, 502, { error: message });
  }
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(publicDir, relative);
  const fromPublic = path.relative(publicDir, file);
  if (fromPublic.startsWith('..') || path.isAbsolute(fromPublic)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  readFile(file, (error, contents) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': contentTypes[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff'
    });
    res.end(contents);
  });
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ready: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_key_here') });
  }
  if (requestUrl.pathname === '/api/settings/key' && req.method === 'POST') {
    return handleKeySetup(req, res);
  }
  if (requestUrl.pathname === '/api/chat' && req.method === 'POST') {
    return handleChat(req, res);
  }
  if (requestUrl.pathname === '/api/transcribe' && req.method === 'POST') {
    return handleTranscription(req, res);
  }
  if (requestUrl.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'That assistant feature isn’t available.' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  serveStatic(req, res, requestUrl.pathname);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`MR BLANK is ready at http://localhost:${port}`);
});
