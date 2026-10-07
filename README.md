# MR BLANK

A small Tamil voice assistant with browser microphone recording, Gemini speech transcription and replies, and browser speech playback. The browser only talks to the local server; the Gemini API key stays in `.env` on the server.

## Requirements

- Node.js 20 or newer (no npm packages are required)
- A Gemini API key
- A recent browser with microphone recording support; Chrome or Edge is a good place to start

## Setup

1. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).
2. In this project directory, run:

   ```bash
   node server.js
   ```

   Or use `npm run dev` for automatic restarts while editing (`npm.cmd run dev` in Windows PowerShell). `npm start` runs without automatic restarts.

3. Open [http://localhost:3000](http://localhost:3000), open **Settings & API key** in the left sidebar, paste your key, and save. MR BLANK stores it in the local `.env` file, which is ignored by Git. The settings form submits directly to the local server; the page's JavaScript never reads the key.

You can also copy `.env.example` to `.env` and replace `your_key_here` manually. The server binds to `127.0.0.1` so the key setup endpoint is only available from this computer.

To use a different port or Gemini model, add `PORT=3001` or `GEMINI_MODEL=<model-name>` to `.env`, then restart the server.

## Voice pipeline

1. Tap the mic to record a short message, then tap again to stop. The browser sends the recording to `POST /api/transcribe`.
2. The Node server sends the audio to Gemini Flash-Lite for transcription, with instructions to preserve Tamil, English, and Tanglish. It returns the transcript to the page.
3. The page displays the recognized words and sends them with recent session messages to `POST /api/chat`.
4. The Node server reads `GEMINI_API_KEY` from `.env` and calls Gemini's `generateContent` endpoint. The key is only submitted to the local server by the settings form; chat requests use it server-side, and the page's JavaScript never reads it.
5. The page displays Gemini's concise, language-aware response and automatically speaks it with the browser's Tamil (`ta-IN`) speech synthesis voice, when available.
6. The speaker control mutes or resumes speech. Clear removes the current session's conversation context.

Typed messages are also supported. Microphone recording requires browser permission and a secure context; `localhost` works for local development. Tamil speech playback uses the voices installed or offered by the browser/operating system.

## Project structure

```text
MR BLANK/
├── .env                 # Local API key and optional settings (Git ignored)
├── .env.example         # Safe environment variable template
├── .gitignore
├── package.json         # Run scripts; no external packages
├── server.js            # Static server, .env loader, and private Gemini endpoint
├── README.md
└── public/
    ├── index.html       # Responsive assistant interface
    ├── styles.css       # Dark theme and responsive layout
    └── app.js           # Speech input/output and conversation UI
```

## Packages

There are no third-party packages. Node.js provides the HTTP server, `.env` loading, and `fetch`; the browser provides microphone recording and speech synthesis.
