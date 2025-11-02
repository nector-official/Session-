import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import P from 'pino';
import fetch from 'node-fetch';
import multer from 'multer';

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = P({ level: process.env.LOG_LEVEL || 'info' });

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(process.cwd(), 'sessions'); // per-request sessions
const SENDER_SESSION_PATH = process.env.SENDER_SESSION_PATH || null; // optional path (e.g. ./sender-auth)
const SENDER_MEGA_LINK = process.env.SENDER_MEGA_LINK || null; // optional direct mega link (if you prefer to auto-download at startup)

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// allow file upload for an authenticated sender session
const upload = multer({ dest: path.join(__dirname, 'uploads') });

// helper: build a clean per-session folder
function sessionPath(id) {
  return path.join(SESSIONS_DIR, id);
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

// optional: try download sender session from MEGA (if you set SENDER_MEGA_LINK)
async function maybeDownloadSenderFromMega() {
  if (!SENDER_MEGA_LINK) return;
  try {
    log.info('Attempting to download sender session from MEGA...');
    const out = path.join(process.cwd(), 'sender-auth.zip');
    // This requires a direct download. If not direct, you must create one.
    const res = await fetch(SENDER_MEGA_LINK);
    if (!res.ok) throw new Error('Failed to download sender link');
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(out, Buffer.from(buffer));
    // unzip
    // Note: unzip only available in the environment if unzip binary present. If not, instruct manual upload.
    log.info('Downloaded sender zip to', out, ' — please unzip it into ./sender-auth manually if needed.');
  } catch (e) {
    log.warn('Could not download sender session from MEGA:', e.message);
  }
}

// Create or load a sending socket if provided (sender)
let senderSock = null;
async function startSenderIfConfigured() {
  if (senderSock) return;
  let senderPath = null;
  if (SENDER_SESSION_PATH && fs.existsSync(SENDER_SESSION_PATH)) senderPath = SENDER_SESSION_PATH;
  else if (fs.existsSync(path.join(process.cwd(), 'sender-auth'))) senderPath = path.join(process.cwd(), 'sender-auth');

  if (!senderPath) {
    log.info('No sender session configured; automatic sending to target not available. You will get a download link instead.');
    return;
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(senderPath);
    const { version } = await fetchLatestBaileysVersion();
    senderSock = makeWASocket({
      version,
      logger: log,
      printQRInTerminal: false,
      browser: Browsers.macOS('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log)
      },
      markOnlineOnConnect: true
    });
    senderSock.ev.on('creds.update', saveCreds);
    senderSock.ev.on('connection.update', (u) => {
      if (u.connection === 'open') log.info('Sender socket connected and ready.');
    });
    log.info('Sender socket started from', senderPath);
  } catch (e) {
    log.error('Failed to start sender socket:', e);
  }
}

// POST /generate { phone: "2547..." }
app.post('/generate', async (req, res) => {
  const phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 8) return res.status(400).json({ error: 'Invalid phone' });

  const sessionId = uuidv4();
  const sessDir = sessionPath(sessionId);
  fs.mkdirSync(sessDir, { recursive: true });

  // create a small state object to communicate
  const stateFile = path.join(sessDir, 'state.json');
  writeJson(stateFile, {
    id: sessionId,
    phone,
    status: 'initializing',
    createdAt: Date.now()
  });

  // start pairing in background
  (async () => {
    try {
      log.info('Starting pairing for', phone, 'session', sessionId);
      const { state, saveCreds } = await useMultiFileAuthState(sessDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        logger: log,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome'),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, log)
        },
        markOnlineOnConnect: true,
        getMessage: async () => ({})
      });

      sock.ev.on('creds.update', saveCreds);

      // update state
      const updateState = (obj) => {
        const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        Object.assign(cur, obj);
        writeJson(stateFile, cur);
      };

      // Request pairing code and expose it to UI
      try {
        updateState({ status: 'requesting_code' });
        const code = await sock.requestPairingCode(phone);
        log.info('Pairing code for', phone, sessionId, code);
        updateState({ status: 'code', code });
      } catch (err) {
        log.error('requestPairingCode failed', err?.message ?? err);
        updateState({ status: 'failed', error: 'requestPairingCode failed: ' + (err?.message || err) });
        // close socket
        try { sock.end(); } catch {}
        return;
      }

      // wait for connection open or timeout
      let closed = false;
      const cleanup = () => {
        try { sock.end(); } catch {}
      };

      const timeoutMs = 2 * 60 * 1000; // 2 minutes
      const timeout = setTimeout(() => {
        if (!closed) {
          updateState({ status: 'timeout' });
          cleanup();
        }
      }, timeoutMs);

      sock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
          log.info('Pairing succeeded for', phone, sessionId);
          clearTimeout(timeout);
          updateState({ status: 'paired' });

          // save creds.json location
          const credsPath = path.join(sessDir, 'creds.json');
          if (state && state.creds) writeJson(credsPath, state.creds);

          // prepare download payload: combined state (creds + keys may be in files)
          // We'll zip or return creds JSON. For simplicity return creds.json.
          updateState({ ready: true, credsPath: '/download/' + sessionId });

          // Optionally: send creds to the paired number via a pre-configured sender socket
          try {
            if (senderSock) {
              const targetJid = phone + '@s.whatsapp.net';
              const credsBuffer = fs.readFileSync(credsPath);
              await senderSock.sendMessage(targetJid, {
                document: credsBuffer,
                fileName: `creds-${phone}.json`,
                mimetype: 'application/json'
              });
              updateState({ sentToPhone: true });
              log.info('Creds sent to', targetJid);
            } else {
              log.info('No sender configured; not sending creds to phone.');
            }
          } catch (sendErr) {
            log.error('Failed to send creds to phone:', sendErr);
            updateState({ sentToPhone: false, sendError: String(sendErr) });
          }

          // close the socket (we're done)
          cleanup();
          closed = true;
        }

        if (update.connection === 'close') {
          log.warn('pair socket closed for', sessionId, update.lastDisconnect?.error?.message || '');
          // if closed before paired, mark
          const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          if (!cur.ready) {
            updateState({ status: 'closed', reason: update.lastDisconnect?.error?.message || 'closed' });
            cleanup();
            closed = true;
          }
        }
      });

    } catch (e) {
      log.error('Pairing background error', e);
      const cur = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      cur.status = 'error';
      cur.error = String(e);
      writeJson(stateFile, cur);
    }
  })();

  return res.json({ sessionId, poll: `/status/${sessionId}` });
});

// GET /status/:id
app.get('/status/:id', (req, res) => {
  const id = req.params.id;
  const f = path.join(SESSIONS_DIR, id, 'state.json');
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'session not found' });
  const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
  return res.json(obj);
});

// GET /download/:id -> serves creds.json (if present)
app.get('/download/:id', (req, res) => {
  const id = req.params.id;
  const creds = path.join(SESSIONS_DIR, id, 'creds.json');
  if (!fs.existsSync(creds)) return res.status(404).send('Not ready');
  res.download(creds, `creds-${id}.json`);
});

// Upload a sender session zip/unpacked (optional) via web UI
app.post('/upload-sender', upload.single('sender'), async (req, res) => {
  // This endpoint accepts a zipped or unpacked sender session; you must ensure it's valid
  // For simplicity: if it's a zip, ask you to unzip into ./sender-auth manually.
  // Here we'll move uploaded folder to ./sender-auth if it looks like a folder with creds.json
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    // Save uploaded file location
    const dest = path.join(process.cwd(), 'sender-upload', req.file.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(req.file.path, dest);
    return res.json({ ok: true, message: 'Uploaded. Please unzip and place files into ./sender-auth' });
  } catch (e) {
    log.error('upload-sender error', e);
    return res.status(500).json({ error: String(e) });
  }
});

// Start optional sender socket (if configured or uploaded)
(async () => {
  await maybeDownloadSenderFromMega();
  await startSenderIfConfigured();

  app.listen(PORT, () => {
    log.info(`Session generator running on port ${PORT}`);
    log.info(`POST /generate  { "phone": "2547..." }`);
  });
})();
