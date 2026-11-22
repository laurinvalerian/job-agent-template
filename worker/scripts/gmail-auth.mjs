#!/usr/bin/env node
// Einmaliger OAuth-Loopback-Flow für Gmail. Holt ein Refresh-Token und schreibt es
// NUR in ~/job-agent-gmail-token.txt (chmod 600), nie auf stdout.
//
//   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-auth.mjs
//
// OAuth-Client in der Google Cloud Console: Typ "Desktop-App" (erlaubt Loopback-Redirects).

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("GMAIL_CLIENT_ID und GMAIL_CLIENT_SECRET als Umgebungsvariablen setzen.");
  process.exit(1);
}

const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"];
// GMAIL_TOKEN_FILE erlaubt eine eigene Datei pro Person (sonst würde der Zugang der ersten Person überschrieben).
const OUT_FILE = process.env.GMAIL_TOKEN_FILE || join(homedir(), "job-agent-gmail-token.txt");
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const state = b64url(randomBytes(16));
const verifier = b64url(randomBytes(48));
const challenge = b64url(createHash("sha256").update(verifier).digest());

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  const finish = (status, text) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(text);
    server.close();
  };
  if (url.searchParams.get("state") !== state) return finish(400, "State stimmt nicht. Abbruch.");
  const error = url.searchParams.get("error");
  if (error) {
    console.error(`Google meldet: ${error}`);
    return finish(400, `Abgebrochen: ${error}`);
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: url.searchParams.get("code") ?? "",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.refresh_token) {
      console.error(`Token-Tausch fehlgeschlagen (${tokenRes.status}): ${data.error ?? "kein refresh_token"}`);
      return finish(500, "Fehlgeschlagen, siehe Terminal.");
    }
    writeFileSync(OUT_FILE, `${data.refresh_token}\n`, { mode: 0o600 });
    chmodSync(OUT_FILE, 0o600);
    console.log(`Refresh-Token gespeichert in ${OUT_FILE} (chmod 600).`);
    console.log("Weiter mit: npx wrangler secret put GMAIL_REFRESH_TOKEN < ~/job-agent-gmail-token.txt");
    finish(200, "Fertig. Du kannst dieses Fenster schliessen.");
  } catch (e) {
    console.error(`Fehler: ${e instanceof Error ? e.message : e}`);
    finish(500, "Fehlgeschlagen, siehe Terminal.");
  }
});

let redirectUri = "";
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  redirectUri = `http://127.0.0.1:${port}`;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent select_account",
    ...(process.env.GMAIL_LOGIN_HINT ? { login_hint: process.env.GMAIL_LOGIN_HINT } : {}),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  console.log("Diese URL im Browser öffnen und mit deiner-gmail-adresse anmelden:\n");
  console.log(auth.toString());
  console.log("\nWarte auf Rückleitung ...");
});
