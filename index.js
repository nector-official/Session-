import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import P from "pino";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import fetch from "node-fetch";

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = P({ level: process.env.LOG_LEVEL || "info" });

const PORT = process.env.PORT || 10000;
const SESSIONS_DIR = path.join(process.cwd(), "sessions"); // where each phone's session files go
const SENDER_AUTH_DIR = path.join(process.cwd(), "sender-auth"); // optional sender session folder

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// multer for sender upload (optional)
const upload = multer({ dest: path.join(__dirname, "uploads") });

/* -------------------------
   Helper utilities
   ------------------------- */
function phoneSafe(phone) {
  return (phone || "").replace(/[^0-9]/g, "");
}
function sessionFolderFor(phone) {
  return path.join(SESSIONS_DIR, phone);
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

/* -------------------------
   Optional sender socket
   ------------------------- */
let senderSock = null;
async function startSenderIfAvailable() {
  if (senderSock) return;
  if (!fs.existsSync(SENDER_AUTH_DIR)) {
    log.info("No sender-auth folder found - auto-sending disabled.");
    return;
  }
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SENDER_AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    senderSock = makeWASocket({
      version,
      logger: log,
      printQRInTerminal: false,
      browser: Browsers.macOS("Chrome"),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log)
      },
      markOnlineOnConnect: true
    });
    senderSock.ev.on("creds.update", saveCreds);
    senderSock.ev.on("connection.update", u => {
      if (u.connection === "open") log.info("Sender socket connected.");
    });
    log.info("Sender started from", SENDER_AUTH_DIR);
  } catch (e) {
    log.error("Failed to start sender socket:", e);
  }
}

/* -------------------------
   API: create pairing session
   ------------------------- */
app.post("/generate", async (req, res) => {
  const phone = phoneSafe(req.body?.phone);
  if (!phone || phone.length < 8) return res.status(400).json({ error: "Invalid phone" });

  const sessDir = sessionFolderFor(phone);
  if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

  // status file visible to UI
  const statusFile = path.join(sessDir, "status.json");
  writeJson(statusFile, { phone, status: "init", createdAt: Date.now() });

  // start pairing in background
  (async () => {
    try {
      log.info("Starting pairing for", phone);
      const { state, saveCreds } = await useMultiFileAuthState(sessDir);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        logger: log,
        printQRInTerminal: false,
        browser: Browsers.macOS("Chrome"),
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, log)
        },
        markOnlineOnConnect: true,
        getMessage: async () => ({})
      });

      sock.ev.on("creds.update", saveCreds);

      // request single static code
      try {
        writeJson(statusFile, { phone, status: "requesting_code" });
        const code = await sock.requestPairingCode(phone);
        log.info("Pairing code for", phone, code);
        writeJson(statusFile, { phone, status: "code", code, requestedAt: Date.now() });
      } catch (err) {
        log.error("requestPairingCode failed:", err?.message ?? err);
        writeJson(statusFile, { phone, status: "error", error: String(err) });
        try { sock.end(); } catch {}
        return;
      }

      // wait for open or timeout
      let finished = false;
      const timeoutMs = 2 * 60 * 1000; // 2 minutes static
      const to = setTimeout(() => {
        if (!finished) {
          writeJson(statusFile, { phone, status: "timeout" });
          try { sock.end(); } catch {}
          finished = true;
        }
      }, timeoutMs);

      sock.ev.on("connection.update", async (update) => {
        if (update.connection === "open") {
          clearTimeout(to);
          if (finished) return;
          finished = true;
          log.info("Paired OK:", phone);
          writeJson(statusFile, { phone, status: "paired", pairedAt: Date.now() });

          // save creds.json (state.creds will be saved via useMultiFileAuthState into files,
          // but write a copy for simpler download)
          const credsPath = path.join(sessDir, "creds.json");
          if (state?.creds) writeJson(credsPath, state.creds);

          // now optionally send creds.json to the phone via sender socket
          try {
            await startSenderIfAvailable();
            if (senderSock && fs.existsSync(credsPath)) {
              const target = phone + "@s.whatsapp.net";
              const buffer = fs.readFileSync(credsPath);
              await senderSock.sendMessage(target, {
                document: buffer,
                fileName: `creds-${phone}.json`,
                mimetype: "application/json"
              });
              writeJson(statusFile, { phone, status: "paired", pairedAt: Date.now(), sentToPhone: true });
              log.info("Sent creds.json to", target);
            } else {
              log.info("Sender not available - creds available via download.");
            }
          } catch (sendErr) {
            log.error("Failed to send creds to phone:", sendErr);
            // still paired; keep creds file for download
            writeJson(statusFile, { phone, status: "paired", pairedAt: Date.now(), sentToPhone: false, sendError: String(sendErr) });
          }

          try { sock.end(); } catch {}
        }

        if (update.connection === "close") {
          // if not yet paired
          const cur = JSON.parse(fs.readFileSync(statusFile, "utf8"));
          if (cur.status !== "paired" && cur.status !== "timeout") {
            writeJson(statusFile, { phone, status: "closed", reason: update.lastDisconnect?.error?.message || "closed" });
            try { sock.end(); } catch {}
          }
        }
      });

    } catch (e) {
      log.error("Background pairing error:", e);
      try { writeJson(path.join(sessDir, "status.json"), { phone, status: "error", error: String(e) }); } catch {}
    }
  })();

  return res.json({ ok: true, phone, statusUrl: `/status/${phone}` });
});

/* GET status */
app.get("/status/:phone", (req, res) => {
  const phone = phoneSafe(req.params.phone);
  const f = path.join(sessionFolderFor(phone), "status.json");
  if (!fs.existsSync(f)) return res.status(404).json({ error: "not found" });
  return res.json(JSON.parse(fs.readFileSync(f, "utf8")));
});

/* GET download creds */
app.get("/download/:phone", (req, res) => {
  const phone = phoneSafe(req.params.phone);
  const creds = path.join(sessionFolderFor(phone), "creds.json");
  if (!fs.existsSync(creds)) return res.status(404).send("Not ready");
  res.download(creds, `creds-${phone}.json`);
});

/* Upload sender package (optional) */
app.post("/upload-sender", upload.single("sender"), (req, res) => {
  // Instruct user to unzip/arrange into ./sender-auth manually on server or via repo.
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });
  return res.json({ ok: true, message: "Uploaded. Please unzip and place files into ./sender-auth (manual step)." });
});

/* very small health page */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* start server */
app.listen(PORT, () => {
  log.info(`Pairing server listening on port ${PORT}`);
  log.info(`Open / to generate pairing codes`);
});
