const fs = require('fs');
const path = require('path');
const readline = require('readline');
const pino = require('pino');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');

const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const SESSION_DIR = path.join(DATA_DIR, 'session');
const CONTROL_FILE = path.join(DATA_DIR, 'campaign-state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const AUDIT_FILE = path.join(DATA_DIR, 'admin-audit.jsonl');
const ADMIN_PORT = Number(process.env.PORT || process.env.ADMIN_PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const BACKUP_PASSPHRASE = process.env.BACKUP_PASSPHRASE || '';
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim())));

let sock = null;
let baileys = null;
let running = true;
let reconnecting = false;
let cachedVersion = null;
let connectionStatus = 'offline';
let campaignPaused = false;
let campaignStopped = false;
let campaignTargets = [];
let campaignMessages = [];
let campaignDelaySec = 10;
let sendIndex = 0;
let adminServer = null;
const adminTokens = new Map();

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  blue: '\x1b[34m',
};

function log(msg, color, isBold = false) {
  const boldCode = isBold ? C.bold : '';
  console.log(`${boldCode}${C[color] || ''}${msg}${C.reset}`);
}

function hardClear() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); 
}

function banner() {
  hardClear();
  console.log(C.cyan + "═".repeat(65) + C.reset);
  console.log(C.bold + C.red + String.raw` _______  _______    _                 _______  _` + C.reset);
  console.log(C.bold + C.magenta + String.raw`(       )(  ____ )  | \    /\|\     /|(  ___  )( (    /|` + C.reset);
  console.log(C.bold + C.yellow + String.raw`| () () || (    )|  |  \  / /| )   ( || (   ) ||  \  ( |` + C.reset);
  console.log(C.bold + C.green + String.raw`| || || || (____)|  |  (_/ / | (___) || (___) ||   \ | |` + C.reset);
  console.log(C.bold + C.cyan + String.raw`| |(_)| ||     __)  |   _ (  |  ___  ||  ___  || (\ \) |` + C.reset);
  console.log(C.bold + C.blue + String.raw`| |   | || (\ (     |  ( \ \ | (   ) || (   ) || | \   |` + C.reset);
  console.log(C.bold + C.magenta + String.raw`| )   ( || ) \ \__  |  /  \ \| )   ( || )   ( || )  \  |` + C.reset);
  console.log(C.bold + C.yellow + String.raw`|/     \||/   \__/  |_/    \/|/     \||/     \||/    )_)` + C.reset);
  console.log(C.bold + C.cyan + "             WHATSAPP ONLINE TERMUX SERVER" + C.reset);
  console.log(C.bold + C.green + "             CREATED BY: MR KHAN");
  console.log(C.cyan + "═".repeat(65) + C.reset);
  console.log("");
}

function makeSocket(state, saveCreds, version) {
  const { default: makeWASocket } = baileys;
  const s = makeWASocket({
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    keepAliveIntervalMs: 30000, 
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 10000,
    maxMsgRetryCount: 5,
    defaultQueryTimeoutMs: 60000,
  });
  s.ev.on('creds.update', saveCreds);
  return s;
}

async function getVersion() {
  if (cachedVersion) return cachedVersion;
  try { 
    const r = await baileys.fetchLatestBaileysVersion(); 
    cachedVersion = r.version; 
    return cachedVersion; 
  } catch (_) { 
    return null; 
  }
}

async function connectAndPair(phone) {
  const { useMultiFileAuthState } = baileys;
  const version = await getVersion();
  let { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let s = makeSocket(state, saveCreds, version);
  const isNew = !state.creds.registered;

  return new Promise((resolve, reject) => {
    let codeShown = false;
    let restarts = 0;
    let qrTimeout = null;

    if (isNew) {
      qrTimeout = setTimeout(() => {
        if (!codeShown) reject(new Error('QR event not received. Check internet and restart.'));
      }, 30000);
    }

    const onUpdate = async (u) => {
      const { connection, lastDisconnect, qr } = u || {};

      if (isNew && !codeShown && qr) {
        codeShown = true;
        clearTimeout(qrTimeout);
        try {
          const code = await s.requestPairingCode(phone);
          console.log("");
          log("═══════════════════════════════════════════", 'yellow');
          log(`  📱 PAIRING CODE:  ${C.bold}${code}${C.reset}`, 'yellow');
          log("═══════════════════════════════════════════", 'yellow');
          log("  1. OPEN WHATSAPP", 'cyan');
          log("  2. SETTINGS → LINKED DEVICES", 'cyan');
          log("  3. LINK A DEVICE → LINK WITH PHONE NUMBER", 'cyan');
          log("  4. ENTER THE CODE SHOWN ABOVE 👆", 'cyan');
          log("═══════════════════════════════════════════", 'yellow');
          console.log("");
          log("⏳ WAITING FOR CONNECTION...", 'cyan', true);
        } catch (e) {
          reject(new Error('Pairing code failed: ' + e.message));
        }
        return;
      }

      if (connection === 'open') {
        clearTimeout(qrTimeout);
        s.ev.off('connection.update', onUpdate);
        connectionStatus = 'connected';
        log("✅ WHATSAPP CONNECTED SUCCESSFULLY!", 'green', true);
        resolve(s);
        return;
      }

      if (connection === 'close') {
        connectionStatus = 'disconnected';
        const code = lastDisconnect?.error?.output?.statusCode;
        const msg = lastDisconnect?.error?.message || 'connection closed';

        if (code === 401) {
          clearTimeout(qrTimeout);
          s.ev.off('connection.update', onUpdate);
          reject(new Error('Logged out. Delete session folder and restart.'));
          return;
        }

        if ((code === 515 || code === 428 || code === 408) && restarts < 5) {
          restarts++;
          log(`🔄 Restarting socket (${restarts})...`, 'yellow', true);
          s.ev.off('connection.update', onUpdate);
          await new Promise(r => setTimeout(r, 1500));
          try {
            const fresh = await useMultiFileAuthState(SESSION_DIR);
            s = makeSocket(fresh.state, fresh.saveCreds, version);
            s.ev.on('connection.update', onUpdate);
          } catch (e) { reject(e); }
          return;
        }

        if (!isNew && !codeShown) {
          clearTimeout(qrTimeout);
          s.ev.off('connection.update', onUpdate);
          reject(new Error('Connection failed: ' + msg));
          return;
        }
      }
    };

    s.ev.on('connection.update', onUpdate);
  });
}

async function reconnect() {
  if (reconnecting) {
    while (reconnecting && running) await new Promise(r => setTimeout(r, 1000));
    return;
  }
  reconnecting = true;
  let attempt = 0;

  while (running) {
    attempt++;
    connectionStatus = 'reconnecting';
    try {
      log(`🔄 CONNECTION LOST. RECONNECTING... (Attempt ${attempt})`, 'yellow', true);
      const { useMultiFileAuthState } = baileys;
      const version = await getVersion();
      const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
      
      const newSock = makeSocket(state, saveCreds, version);
      
      await new Promise((res, rej) => {
        const t = setTimeout(() => { 
          try { newSock.end(undefined); } catch(_) {}
          rej(new Error('timeout')); 
        }, 30000);
        
        const onUp = (u) => {
          if (u.connection === 'open') { 
            clearTimeout(t); 
            newSock.ev.off('connection.update', onUp); 
            res(); 
          }
          if (u.connection === 'close') { 
            clearTimeout(t); 
            newSock.ev.off('connection.update', onUp); 
            const code = u.lastDisconnect?.error?.output?.statusCode;
            rej(new Error(code === 401 ? 'logged_out' : 'close')); 
          }
        };
        newSock.ev.on('connection.update', onUp);
      });
      
      sock = newSock;
      connectionStatus = 'connected';
      log("✅ RECONNECTED SUCCESSFULLY! Resuming sending...", 'green', true);
      reconnecting = false;
      return;
      
    } catch (e) {
      if (e.message === 'logged_out') {
        connectionStatus = 'logged_out';
        log('❌ ACCOUNT LOGGED OUT. DELETE SESSION FOLDER.', 'red', true);
        process.exit(1);
      }
      log(`❌ Reconnect attempt ${attempt} failed. Retrying in 5s...`, 'red');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  reconnecting = false;
}

function formatPhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function saveControl() {
  const data = {
    targets: campaignTargets,
    messages: campaignMessages,
    delaySec: campaignDelaySec,
    sendIndex,
    paused: campaignPaused,
    stopped: campaignStopped,
  };
  fs.writeFileSync(CONTROL_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function loadControl() {
  try {
    const data = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    campaignTargets = Array.isArray(data.targets) ? data.targets : [];
    campaignMessages = Array.isArray(data.messages) ? data.messages : [];
    campaignDelaySec = Math.max(1, Number(data.delaySec) || 10);
    sendIndex = Math.max(0, Number(data.sendIndex) || 0);
    campaignPaused = Boolean(data.paused);
    campaignStopped = Boolean(data.stopped);
    return campaignTargets.length > 0 && campaignMessages.length > 0;
  } catch (_) { return false; }
}

function adminAudit(action, details = {}) {
  const row = { at: new Date().toISOString(), action, details };
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n', { mode: 0o600 });
  log(`[ADMIN] ${action} ${JSON.stringify(details)}`, 'yellow');
}

function collectBackupFiles(root, current = root, output = []) {
  if (!fs.existsSync(current)) return output;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) collectBackupFiles(root, full, output);
    else if (entry.isFile()) {
      output.push({ path: path.relative(root, full).split(path.sep).join('/'), data: fs.readFileSync(full).toString('base64') });
    }
  }
  return output;
}

function makeEncryptedBackup() {
  if (BACKUP_PASSPHRASE.length < 16) throw new Error('Set BACKUP_PASSPHRASE (at least 16 characters) to enable backups.');
  const files = [];
  if (fs.existsSync(SESSION_DIR)) collectBackupFiles(DATA_DIR, SESSION_DIR, files);
  for (const file of [CONTROL_FILE, AUDIT_FILE]) {
    if (fs.existsSync(file)) files.push({ path: path.relative(DATA_DIR, file).split(path.sep).join('/'), data: fs.readFileSync(file).toString('base64') });
  }
  const zipped = zlib.gzipSync(Buffer.from(JSON.stringify({ format: 'mrk-whatsapp-backup-v1', createdAt: new Date().toISOString(), files })));
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(BACKUP_PASSPHRASE, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(zipped), cipher.final()]);
  return Buffer.from(JSON.stringify({ format: 'mrk-encrypted-backup-v1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }, null, 2));
}

function autoBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const dateSlot = Math.floor(Date.now() / 86400000) % 7;
    const file = path.join(BACKUP_DIR, `rolling-${dateSlot}.mrkbackup`);
    fs.writeFileSync(file, makeEncryptedBackup(), { mode: 0o600 });
    adminAudit('automatic_backup_created', { file: path.basename(file) });
  } catch (error) {
    log(`⚠️ BACKUP FAILED: ${error.message}`, 'red');
  }
}

const ADMIN_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Admin</title><style>
body{margin:0;background:#0c1420;color:#edf4f7;font:15px system-ui,Arial}.wrap{max-width:980px;margin:24px auto;padding:0 14px}.card{background:#142231;border:1px solid #2a3c50;border-radius:14px;padding:18px;margin:14px 0}h1,h2{margin:0 0 10px}p,.muted{color:#9db0c0}button{background:#24384b;color:#fff;border:1px solid #3b5871;border-radius:9px;padding:9px 13px;margin:4px;cursor:pointer}button.red{background:#542d34}button.green{background:#17664e}input,textarea{width:100%;box-sizing:border-box;margin:5px 0 12px;background:#0b1521;color:#fff;border:1px solid #34495f;border-radius:8px;padding:10px}textarea{min-height:90px}.row{display:flex;gap:7px;flex-wrap:wrap}.badge{display:inline-block;background:#233b4c;padding:5px 10px;border-radius:20px}.hide{display:none}.log{border-bottom:1px solid #273a4a;padding:7px 0;font-size:13px;word-break:break-word}.warn{color:#ffcf82}</style></head><body><div class="wrap">
<section id="login" class="card"><h1>MR KHAN • ADMIN</h1><p>Sign in to control the existing terminal sender.</p><input id="pw" type="password" placeholder="Admin password"><button id="loginBtn" class="green">Sign in</button><p class="warn">Use only for recipients who agreed to receive messages.</p></section>
<main id="panel" class="hide"><div class="row" style="justify-content:space-between"><h1>WhatsApp Admin Panel</h1><button id="logout">Sign out</button></div>
<section class="card"><h2>Live status</h2><p id="status"></p><div class="row"><button data-action="pause">Pause sending</button><button data-action="resume" class="green">Resume sending</button><button data-action="stop" class="red">Stop sending</button><button data-action="stopAll" class="red">Stop all (sender + session)</button><button data-action="resumeAll" class="green">Resume all</button></div><p class="muted">The original script supports one linked WhatsApp session. A stopped campaign does not log the phone out.</p></section>
<section class="card"><h2>Edit current targets/messages</h2><p class="muted">Targets: one phone number or JID per line. Messages: one message per line. These replace the original running list.</p><label>Targets</label><textarea id="targets"></textarea><label>Messages</label><textarea id="messages"></textarea><label>Delay between sends (seconds; minimum 10)</label><input id="delay" type="number" min="10"><button id="save" class="green">Save changes</button></section>
<section class="card"><h2>Backup</h2><p>Encrypted rolling backup is made daily on the host. Download a separate copy before changing hosts.</p><button id="backup" class="green">Download encrypted backup now</button><label>Restore a .mrkbackup file (first choose Stop all)</label><input id="restoreFile" type="file" accept=".mrkbackup,application/octet-stream,application/json"><button id="restore" class="red">Restore backup</button><p class="muted">Keep BACKUP_PASSPHRASE safe. Without it, the backup cannot be decrypted. Also enable your hosting provider's persistent-volume snapshot; a local backup cannot survive loss of the host disk.</p></section>
<section class="card"><h2>Admin activity / recent sends</h2><div id="logs"></div></section></main></div><script>
let token=sessionStorage.getItem('admin_token')||'';const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,body){const r=await fetch(url,{method:body?'POST':'GET',headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error((await r.json()).error||'Request failed');if(r.headers.get('content-type')?.includes('application/json'))return r.json();return r;}
function signed(){ $('login').classList.add('hide');$('panel').classList.remove('hide');refresh();}
async function refresh(){try{const d=await api('/api/state');$('status').innerHTML='<span class="badge">WhatsApp: '+esc(d.connection)+'</span> <span class="badge">Sending: '+esc(d.sendState)+'</span> <span class="badge">Targets: '+d.targetCount+'</span> <span class="badge">Messages: '+d.messageCount+'</span> <span class="badge">Next index: '+(d.index+1)+'</span>';$('targets').value=d.targets.map(t=>t.label||t.jid).join('\n');$('messages').value=d.messages.join('\n');$('delay').value=d.delaySec;$('logs').innerHTML=d.logs.map(x=>'<div class="log"><b>'+esc(x.action)+'</b> · '+esc(x.at)+' · '+esc(JSON.stringify(x.details||{}))+'</div>').join('')||'<p class="muted">No log entries.</p>';}catch(e){console.error(e)}}
$('loginBtn').onclick=async()=>{try{const d=await api('/api/login',{password:$('pw').value});token=d.token;sessionStorage.setItem('admin_token',token);signed()}catch(e){alert(e.message)}};$('logout').onclick=()=>{token='';sessionStorage.removeItem('admin_token');location.reload()};
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{try{await api('/api/action',{action:b.dataset.action});await refresh()}catch(e){alert(e.message)}});
$('save').onclick=async()=>{if(!confirm('Confirm every recipient has opted in to these messages?'))return;try{await api('/api/edit',{targets:$('targets').value.split(/\r?\n/).filter(Boolean),messages:$('messages').value.split(/\r?\n/).filter(Boolean),delaySec:Number($('delay').value),consentConfirmed:true});alert('Saved.');await refresh()}catch(e){alert(e.message)}};
$('backup').onclick=async()=>{try{const r=await api('/api/backup');const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='whatsapp-backup.mrkbackup';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}catch(e){alert(e.message)}};
$('#restore').onclick=async()=>{const file=$('restoreFile').files[0];if(!file)return alert('Choose a .mrkbackup file.');if(!confirm('Restore saved WhatsApp session and campaign data? Stop all first.'))return;try{const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const b of bytes)binary+=String.fromCharCode(b);await api('/api/restore',{backupBase64:btoa(binary)});alert('Restored. Sending remains stopped; review status and press Resume all.');await refresh()}catch(e){alert(e.message)}};
if(token)signed();setInterval(()=>{if(token)refresh()},5000);
</script></body></html>`;

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 20_000_000) { reject(new Error('Request too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function startAdminPanel() {
  if (ADMIN_PASSWORD.length < 16) throw new Error('Set ADMIN_PASSWORD to a unique secret of at least 16 characters.');
  if (BACKUP_PASSPHRASE.length < 16) throw new Error('Set BACKUP_PASSPHRASE to a separate secret of at least 16 characters.');
  adminServer = http.createServer(async (req, res) => {
    const sendJson = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' }); return res.end(ADMIN_HTML); }
    try {
      const body = ['POST','PUT'].includes(req.method) ? await readHttpBody(req) : {};
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const supplied = Buffer.from(String(body.password || '')); const expected = Buffer.from(ADMIN_PASSWORD);
        const good = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
        if (!good) return sendJson(401, { error: 'Wrong password.' });
        const token = crypto.randomBytes(32).toString('hex'); adminTokens.set(token, Date.now() + 8 * 60 * 60 * 1000);
        adminAudit('admin_login'); return sendJson(200, { token });
      }
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!adminTokens.has(token) || adminTokens.get(token) < Date.now()) { adminTokens.delete(token); return sendJson(401, { error: 'Sign in again.' }); }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        let logs = [];
        try { logs = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-60).map(x => JSON.parse(x)).reverse(); } catch (_) {}
        return sendJson(200, { connection: connectionStatus, sendState: campaignStopped ? 'stopped' : campaignPaused ? 'paused' : 'running', targetCount: campaignTargets.length, messageCount: campaignMessages.length, index: sendIndex, delaySec: campaignDelaySec, targets: campaignTargets, messages: campaignMessages, logs });
      }
      if (req.method === 'POST' && url.pathname === '/api/action') {
        const action = body.action;
        if (action === 'pause') campaignPaused = true;
        else if (action === 'resume') { campaignPaused = false; campaignStopped = false; }
        else if (action === 'stop') campaignStopped = true;
        else if (action === 'stopAll') { campaignPaused = true; campaignStopped = true; connectionStatus = 'paused'; try { sock?.end(undefined); } catch (_) {} sock = null; }
        else if (action === 'resumeAll') { campaignPaused = false; campaignStopped = false; if (!sock) connectionStatus = 'reconnecting'; }
        else return sendJson(400, { error: 'Unknown action.' });
        saveControl(); adminAudit(`action_${action}`); return sendJson(200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/edit') {
        if (body.consentConfirmed !== true) return sendJson(400, { error: 'Confirm that all recipients opted in before editing.' });
        const targets = Array.isArray(body.targets) ? body.targets.map(value => String(value).trim()).filter(Boolean) : [];
        const messages = Array.isArray(body.messages) ? body.messages.map(value => String(value).trim()).filter(Boolean) : [];
        if (!targets.length || !messages.length || targets.length > 500 || messages.length > 500) return sendJson(400, { error: 'Provide 1–500 targets and 1–500 messages.' });
        const parsedTargets = targets.map(value => {
          if (value.includes('@g.us') || value.includes('@s.whatsapp.net')) return { jid: value, label: value };
          const number = formatPhone(value); if (!/^\d{7,15}$/.test(number)) throw new Error(`Invalid target: ${value}`);
          return { jid: `${number}@s.whatsapp.net`, label: number };
        });
        campaignTargets = parsedTargets; campaignMessages = messages;
        campaignDelaySec = Math.max(10, Math.min(3600, Number(body.delaySec) || 10));
        sendIndex = 0; saveControl(); adminAudit('campaign_edited', { targets: parsedTargets.length, messages: messages.length, delaySec: campaignDelaySec });
        return sendJson(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/backup') {
        const backup = makeEncryptedBackup(); adminAudit('manual_backup_downloaded', { bytes: backup.length });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="whatsapp-backup-${new Date().toISOString().slice(0,10)}.mrkbackup"`, 'Cache-Control': 'no-store' }); return res.end(backup);
      }
      if (req.method === 'POST' && url.pathname === '/api/restore') {
        if (!campaignPaused || !campaignStopped || sock) return sendJson(409, { error: 'Press Stop all first; restore is allowed only while sending and session are stopped.' });
        const encoded = String(body.backupBase64 || '');
        if (!encoded || encoded.length > 19_000_000) return sendJson(400, { error: 'Backup is missing or too large.' });
        const envelope = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
        if (envelope.format !== 'mrk-encrypted-backup-v1') return sendJson(400, { error: 'Unsupported backup format.' });
        const salt = Buffer.from(envelope.salt, 'base64'); const iv = Buffer.from(envelope.iv, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(BACKUP_PASSPHRASE, salt, 32), iv);
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plain = zlib.gunzipSync(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]));
        const snapshot = JSON.parse(plain.toString('utf8'));
        if (snapshot.format !== 'mrk-whatsapp-backup-v1' || !Array.isArray(snapshot.files)) return sendJson(400, { error: 'Invalid backup contents.' });
        for (const item of snapshot.files) {
          const parts = String(item.path || '').split('/');
          if (!['session', 'campaign-state.json', 'admin-audit.jsonl'].includes(parts[0]) || parts.some(part => !part || part === '.' || part === '..') || path.isAbsolute(item.path)) return sendJson(400, { error: 'Backup contains an unsafe path.' });
        }
        try { sock?.end(undefined); } catch (_) {}
        sock = null;
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
        fs.rmSync(CONTROL_FILE, { force: true });
        for (const item of snapshot.files) {
          const target = path.resolve(DATA_DIR, item.path);
          if (!target.startsWith(DATA_DIR + path.sep)) throw new Error('Unsafe backup path.');
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, Buffer.from(item.data, 'base64'), { mode: 0o600 });
        }
        loadControl(); campaignPaused = true; campaignStopped = true; saveControl();
        connectionStatus = 'paused'; adminAudit('backup_restored', { createdAt: snapshot.createdAt });
        return sendJson(200, { ok: true });
      }
      sendJson(404, { error: 'Not found.' });
    } catch (error) { sendJson(400, { error: error.message }); }
  });
  adminServer.listen(ADMIN_PORT, '0.0.0.0', () => log(`🌐 ADMIN PANEL LISTENING ON PORT ${ADMIN_PORT} (open your hosting HTTPS URL)`, 'cyan', true));
}

async function senderLoop() {
  while (running) {
    if (campaignPaused || campaignStopped) { await sleep(1000); continue; }
    if (!sock) {
      await reconnect();
      if (!running) break;
      if (!sock) { await sleep(2000); continue; }
    }
    if (!campaignTargets.length || !campaignMessages.length) { await sleep(1000); continue; }
    const msg = campaignMessages[sendIndex % campaignMessages.length];
    const target = campaignTargets[sendIndex % campaignTargets.length];
    const ts = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi' });
    const preview = msg.length > 70 ? msg.slice(0, 70) + '...' : msg;
    try {
      await sock.sendMessage(target.jid, { text: msg });
      console.log('\n' + C.bold + C.green + '═══════════════════════════════════════════' + C.reset);
      log(`[TIME: ${ts}] ✅ MESSAGE SENT SUCCESSFULLY`, 'green', true);
      log(`🎯 TARGET : ${target.label}`, 'cyan');
      log(`💬 MESSAGE: ${preview}`, 'white');
      console.log(C.bold + C.green + '═══════════════════════════════════════════' + C.reset + '\n');
      sendIndex++;
      saveControl();
      adminAudit('message_sent', { target: target.label, index: sendIndex });
    } catch (e) {
      log(`[${ts}] ❌ FAILED TO SEND → ${target.label}`, 'red', true);
      log(`Reason: ${e.message}`, 'red');
      try { sock.end(undefined); } catch (_) {}
      sock = null; connectionStatus = 'reconnecting';
      await sleep(2000);
      continue;
    }
    await sleep(campaignDelaySec * 1000);
  }
}

async function main() {
  banner();
  baileys = await import('@whiskeysockets/baileys');
  const { useMultiFileAuthState } = baileys;

  const { state } = await useMultiFileAuthState(SESSION_DIR);
  const isRegistered = !!state.creds.registered;

  let phone = null;
  if (!isRegistered) {
    while (true) {
      const p = await ask(`${C.bold}${C.cyan}📱 ENTER WHATSAPP NUMBER (WITH COUNTRY CODE): ${C.reset}`);
      const clean = formatPhone(p);
      if (/^\d{7,15}$/.test(clean)) { phone = clean; break; }
      log('❌ Invalid number. Enter 7-15 digits.', 'red');
    }
    log("⏳ CONNECTING TO WHATSAPP...", 'cyan', true);
  } else {
    log("✅ SESSION FOUND. CONNECTING...", 'cyan', true);
  }

  sock = await connectAndPair(phone);

  hardClear(); 
  banner();

  if (!loadControl()) {
    log("═══════════════════════════════════════════", 'magenta');
    log("  🎯 SELECT MESSAGE TARGET", 'magenta', true);
    log("  [1] SINGLE NUMBER / CONTACT", 'cyan');
    log("  [2] GROUP CHAT", 'cyan');
    log("═══════════════════════════════════════════", 'magenta');

    const choice = (await ask(`${C.bold}${C.cyan}➤ TYPE 1 OR 2: ${C.reset}`)) || '1';
    if (choice === '2') {
      log("📥 LOADING GROUPS...", 'yellow', true);
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups || {});
      if (!list.length) { log("❌ No groups found.", 'red'); process.exit(1); }
      list.forEach((g, i) => console.log(`  ${C.bold}${C.cyan}[${i + 1}]${C.reset} ${g.subject}`));
      const pick = await ask(`\n${C.bold}${C.cyan}➤ GROUP NUMBER(S) (COMMA SEPARATED): ${C.reset}`);
      const picks = pick.split(',').map(x => parseInt(x.trim()) - 1).filter(n => n >= 0 && n < list.length);
      if (!picks.length) { log("❌ No group selected.", 'red'); process.exit(1); }
      campaignTargets = picks.map(i => ({ jid: list[i].id, label: list[i].subject }));
    } else {
      const raw = await ask(`${C.bold}${C.cyan}📞 TARGET NUMBER(S) (COMMA SEPARATED): ${C.reset}`);
      const nums = raw.split(/[ ,\s]+/).map(formatPhone).filter(Boolean);
      if (!nums.length) { log("❌ No numbers provided.", 'red'); process.exit(1); }
      campaignTargets = nums.map(n => ({ jid: `${n}@s.whatsapp.net`, label: n }));
    }
    log(`✅ ${campaignTargets.length} TARGET(S) SET.`, 'green', true);
    const consent = await ask(`${C.bold}${C.yellow}Confirm all recipients opted in? Type YES to continue: ${C.reset}`);
    if (consent.toUpperCase() !== 'YES') { log('❌ Consent not confirmed; sender was not started.', 'red'); process.exit(1); }

    const msgPath = (await ask(`${C.bold}${C.cyan}📄 MESSAGES FILE PATH (DEFAULT: messages.txt): ${C.reset}`)) || 'messages.txt';
    const absPath = path.isAbsolute(msgPath) ? msgPath : path.join(process.cwd(), msgPath);
    if (!fs.existsSync(absPath)) { log(`❌ File not found: ${absPath}`, 'red'); process.exit(1); }
    campaignMessages = fs.readFileSync(absPath, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!campaignMessages.length) { log("❌ Messages file is empty.", 'red'); process.exit(1); }
    log(`✅ ${campaignMessages.length} MESSAGES LOADED.`, 'green', true);

    const delayInput = await ask(`${C.bold}${C.cyan}⏱️  DELAY BETWEEN MESSAGES (SECONDS, DEFAULT 10): ${C.reset}`);
    campaignDelaySec = Math.max(10, parseInt(delayInput) || 10);
    saveControl();
  } else {
    log(`✅ SAVED SETTINGS RESTORED: ${campaignTargets.length} target(s), ${campaignMessages.length} message(s).`, 'green', true);
  }

  rl.close();
  startAdminPanel();
  autoBackup();
  setInterval(autoBackup, 24 * 60 * 60 * 1000).unref();

  console.log("");
  log("═══════════════════════════════════════════", 'magenta');
  log("  🚀 ORIGINAL SENDER RUNNING WITH ADMIN CONTROLS", 'magenta', true);
  log(`  📨 TOTAL MESSAGES: ${campaignMessages.length}`, 'cyan');
  log(`  🎯 TOTAL TARGETS:  ${campaignTargets.length}`, 'cyan');
  log(`  ⏱️  DELAY TIME:     ${campaignDelaySec}s`, 'cyan');
  log(`  🖥️  ADMIN PORT:      ${ADMIN_PORT}`, 'cyan');
  log("  🛑 CTRL+C TO EXIT; USE ADMIN PANEL TO PAUSE/RESUME", 'red');
  log("═══════════════════════════════════════════", 'magenta');
  console.log("");

  await senderLoop();
}

process.on('SIGINT', () => {
  console.log("");
  log("👋 STOPPING BOT...", 'yellow', true);
  running = false;
  connectionStatus = 'stopping';
  try { adminServer?.close(); } catch (_) {}
  try { sock?.end(undefined); } catch (_) {}
  try { rl.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
});

process.on('SIGTERM', () => {
  running = false;
  connectionStatus = 'stopping';
  try { adminServer?.close(); } catch (_) {}
  try { sock?.end(undefined); } catch (_) {}
  try { rl.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
});

main().catch(e => {
  log('❌ FATAL ERROR: ' + (e?.message || e), 'red', true);
  process.exit(1);
});
