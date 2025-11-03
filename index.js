/********************************************************************
 * index.js
 * Multi-number pairing server (pairing-code method). Saves creds.json
 * and sends the creds.json file to the newly linked WhatsApp account.
 *
 * Usage:
 *  - npm install
 *  - node index.js
 *  - Open http://<your-host>/  (UI at /)
 *
 * Important:
 *  - sessions are stored in ./sessions/<phone> as creds.json and state files.
 *  - pairing timeout is 2 minutes (static code); if you miss it, generate again.
 ********************************************************************/

import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import P from "pino";
import { fileURLToPath } from "url";

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = P({ level: process.env.LOG_LEVEL || "info" });

const PORT = process.env.PORT || 10000;
const SESSIONS_DIR = path.join(process.cwd(), "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// helper
const phoneSafe = (s) => (s || "").replace(/[^0-9]/g, "");
const sessionFolderFor = (phone) => path.join(SESSIONS_DIR, phone);
const writeJson = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2), "utf8");

// serve simple health/home
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/**
 * POST /generate
 * { phone: "2547..." }
 * starts a background pairing flow and returns { ok: true, statusUrl }
 */
app.post("/generate", async (req, res) => {
  const phone = phoneSafe(req.body?.phone);
  if (!phone || phone.length < 8) return res.status(400).json({ error: "Invalid phone" });

  const sessDir = sessionFolderFor(phone);
  if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

  const statusFile = path.join(sessDir, "status.json");
  writeJson(statusFile, { phone, status: "init", createdAt: Date.now() });

  // spawn background pairing
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

      // Request a single static code
      try {
        writeJson(statusFile, { phone, status: "requesting_code", requestedAt: Date.now() });
        const code = await sock.requestPairingCode(phone);
        log.info("Pairing code", phone, code);
        writeJson(statusFile, { phone, status: "code", code, requestedAt: Date.now() });
      } catch (err) {
        log.error("requestPairingCode failed:", err?.message ?? err);
        writeJson(statusFile, { phone, status: "error", error: String(err) });
        try { sock.end(); } catch {}
        return;
      }

      // Wait for pairing or timeout
      let finished = false;
      const timeoutMs = 2 * 60 * 1000; // 2 minutes
      const to = setTimeout(() => {
        if (!finished) {
          writeJson(statusFile, { phone, status: "timeout" });
          try { sock.end(); } catch {}
          finished = true;
        }
      }, timeoutMs);

      sock.ev.on("connection.update", async (update) => {
        if (update.connection === "open") {
          // paired successfully
          clearTimeout(to);
          if (finished) return;
          finished = true;
          log.info("Paired OK:", phone);
          writeJson(statusFile, { phone, status: "paired", pairedAt: Date.now() });

          // write creds.json copy for easy download
          const credsPath = path.join(sessDir, "creds.json");
          if (state?.creds) writeJson(credsPath, state.creds);

          // send creds.json to the same number (it can message itself)
          try {
            const targetJid = state.creds?.me?.id || (phone + "@s.whatsapp.net");
            if (!targetJid) {
              log.warn("No target JID to send creds to.");
            } else {
              const buffer = Buffer.from(JSON.stringify(state.creds, null, 2), "utf8");
              await sock.sendMessage(targetJid, {
                document: buffer,
                fileName: `creds-${phone}.json`,
                mimetype: "application/json"
              });
              log.info("Sent creds.json to", targetJid);
              writeJson(statusFile, { phone, status: "paired", pairedAt: Date.now(), sentToPhone: true });
            }
          } catch (sendErr) {
            log.error("Failed to send creds to phone:", sendErr);
            writeJson(statusFile, { phone, status: "paired", pairedAt: Date.now(), sentToPhone: false, sendError: String(sendErr) });
          }

          try { sock.end(); } catch {}
        }

        if (update.connection === "close") {
          const cur = JSON.parse(fs.readFileSync(statusFile, "utf8"));
          if (!["paired", "timeout"].includes(cur.status)) {
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

/* status endpoint */
app.get("/status/:phone", (req, res) => {
  const phone = phoneSafe(req.params.phone);
  const f = path.join(sessionFolderFor(phone), "status.json");
  if (!fs.existsSync(f)) return res.status(404).json({ error: "not found" });
  return res.json(JSON.parse(fs.readFileSync(f, "utf8")));
});

/* download endpoint */
app.get("/download/:phone", (req, res) => {
  const phone = phoneSafe(req.params.phone);
  const creds = path.join(sessionFolderFor(phone), "creds.json");
  if (!fs.existsSync(creds)) return res.status(404).send("Not ready");
  res.download(creds, `creds-${phone}.json`);
});

/* start server */
app.listen(PORT, () => {
  log.info(`Pairing server listening on port ${PORT}`);
  log.info(`Open / to generate pairing codes`);
});
