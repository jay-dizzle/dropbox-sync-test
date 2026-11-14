// Dropbox-Sync-Test: reine Browser-App, kein eigener Server.
// Jedes Gerät schreibt seine Änderungen in eine eigene Datei im App-Ordner
// (g-<gerät>.json) und liest die Dateien der anderen Geräte.

const APP_KEY = 'r24kfqe4tprgsc3';
const RUECKSPRUNG = new URL('./', location.href).href;
const AUTH = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

const $ = id => document.getElementById(id);
const lies = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const schreib = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const jetzt = () => new Date().toISOString();
const zeit = iso => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'medium' }) : '–';

// ---------- Gerät, Einträge, Protokoll ----------

let geraet = lies('geraet', null);
if (!geraet) {
  const art = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad'
    : /Android/.test(navigator.userAgent) ? 'Android' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Gerät';
  geraet = { id: crypto.randomUUID().slice(0, 8), name: art };
  schreib('geraet', geraet);
}

// Änderungen als Operationen: {id, typ:'neu'|'weg', text, zeit, geraet}
let eigene = lies('ops-eigen', []);
let fremde = lies('ops-fremd', {});   // {datei: {rev, geraet, ops}}
let ungesendet = lies('ungesendet', false);

function log(text) {
  const l = lies('log', []);
  l.unshift(`${zeit(jetzt())}  ${text}`);
  schreib('log', l.slice(0, 40));
  zeigeInfo();
}

function eintraege() {
  const alle = [...eigene, ...Object.values(fremde).flatMap(f => f.ops)];
  const weg = new Set(alle.filter(o => o.typ === 'weg').map(o => o.id));
  const neu = new Map();
  for (const o of alle) if (o.typ === 'neu' && !weg.has(o.id)) neu.set(o.id, o);
  return [...neu.values()].sort((a, b) => b.zeit.localeCompare(a.zeit));
}

function aendern(op) {
  eigene.push({ ...op, zeit: jetzt(), geraet: geraet.name });
  schreib('ops-eigen', eigene);
  ungesendet = true; schreib('ungesendet', true);
  zeigeListe();
  syncBald(800);
}

// ---------- Anmeldung (OAuth mit PKCE, ohne Server) ----------

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function anmeldeAdresse(mitRuecksprung) {
  const pruef = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pruef)));
  schreib('pkce', { pruef, mitRuecksprung, seit: jetzt() });
  const p = new URLSearchParams({
    client_id: APP_KEY, response_type: 'code', token_access_type: 'offline',
    code_challenge: challenge, code_challenge_method: 'S256',
  });
  if (mitRuecksprung) p.set('redirect_uri', RUECKSPRUNG);
  return `${AUTH}?${p}`;
}

async function codeEinloesen(code) {
  const pkce = lies('pkce', null);
  if (!pkce) throw new Error('Kein Anmeldevorgang gefunden (Prüfwert fehlt)');
  const p = new URLSearchParams({
    code: code.trim(), grant_type: 'authorization_code', client_id: APP_KEY, code_verifier: pkce.pruef,
  });
  if (pkce.mitRuecksprung) p.set('redirect_uri', RUECKSPRUNG);
  const r = await fetch(TOKEN, { method: 'POST', body: p });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || r.status);
  localStorage.removeItem('pkce');
  schreib('token', {
    access: d.access_token, refresh: d.refresh_token,
    ablauf: Date.now() + d.expires_in * 1000, seit: jetzt(), erneuert: null,
  });
  log(`Verbunden (${pkce.mitRuecksprung ? 'Rücksprung' : 'Code'}, ${modus()})`);
}

async function zugang() {
  const t = lies('token', null);
  if (!t) return null;
  if (Date.now() < t.ablauf - 60_000) return t.access;
  const r = await fetch(TOKEN, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: APP_KEY }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 400 || r.status === 401) {
      localStorage.removeItem('token');
      log(`Anmeldung abgelaufen (${d.error || r.status}), angemeldet seit ${zeit(t.seit)}`);
      zeigeAnsicht();
      return null;
    }
    throw new Error(`Erneuern fehlgeschlagen: ${r.status}`);
  }
  schreib('token', { ...t, access: d.access_token, ablauf: Date.now() + d.expires_in * 1000, erneuert: jetzt() });
  log('Zugang erneuert');
  return d.access_token;
}

// ---------- Dropbox-Aufrufe ----------

async function api(pfad, body) {
  const r = await fetch(API + pfad, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await zugang()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${pfad}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function hochladen(pfad, inhalt) {
  const r = await fetch(CONTENT + '/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await zugang()}`, 'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: pfad, mode: 'overwrite', mute: true }),
    },
    body: inhalt,
  });
  if (!r.ok) throw new Error(`Hochladen: ${r.status} ${await r.text()}`);
}

async function herunterladen(pfad) {
  const r = await fetch(CONTENT + '/files/download', {
    method: 'POST',
    headers: { Authorization: `Bearer ${await zugang()}`, 'Dropbox-API-Arg': JSON.stringify({ path: pfad }) },
  });
  if (!r.ok) throw new Error(`Herunterladen: ${r.status} ${await r.text()}`);
  return r.json();
}

// ---------- Abgleich ----------

let laeuft = false, timer = null;
const syncBald = ms => { clearTimeout(timer); timer = setTimeout(sync, ms); };

async function sync() {
  // navigator.onLine bleibt auf dem iPhone nach dem Flugmodus manchmal auf false hängen,
  // deshalb immer selbst versuchen und nur echte Netzfehler als „Offline“ werten.
  if (laeuft || !lies('token', null)) return;
  laeuft = true; status('Gleicht ab …');
  try {
    const eigeneDatei = `/g-${geraet.id}.json`;
    if (ungesendet) {
      const anzahl = eigene.length;
      await hochladen(eigeneDatei, JSON.stringify({ geraet: geraet.name, ops: eigene }));
      if (eigene.length === anzahl) { ungesendet = false; schreib('ungesendet', false); }
      log(`Hochgeladen (${anzahl} Änderungen)`);
    }
    let liste = await api('/files/list_folder', { path: '' });
    const dateien = [...liste.entries];
    while (liste.has_more) { liste = await api('/files/list_folder/continue', { cursor: liste.cursor }); dateien.push(...liste.entries); }

    let neu = 0;
    for (const d of dateien) {
      if (d['.tag'] !== 'file' || !/^g-.+\.json$/.test(d.name) || d.path_lower === eigeneDatei.toLowerCase()) continue;
      if (fremde[d.name]?.rev === d.rev) continue;
      const inhalt = await herunterladen(d.path_lower);
      fremde[d.name] = { rev: d.rev, geraet: inhalt.geraet, ops: inhalt.ops };
      neu++;
    }
    if (neu) { schreib('ops-fremd', fremde); log(`${neu} Gerätedatei(en) neu geladen`); }
    schreib('letzterSync', { zeit: jetzt(), dateien: dateien.length });
    status('Synchron', 'ok');
    zeigeListe();
  } catch (e) {
    if (e instanceof TypeError) {
      // fetch scheitert ohne Netz mit TypeError; leise erneut versuchen
      if ($('status').textContent !== 'Offline') log(`Kein Netz${ungesendet ? ', Änderungen warten' : ''}`);
      status('Offline', 'warn');
      syncBald(15_000);
    } else {
      status('Fehler', 'fehler');
      log(`Fehler: ${e.message}`);
    }
  } finally {
    laeuft = false;
    zeigeInfo();
  }
}

// ---------- Anzeige ----------

const modus = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'Home-Bildschirm' : 'Browser';

function status(text, art = '') { $('status').textContent = text; $('status').className = `pille ${art}`; }

function zeigeAnsicht() {
  const an = !!lies('token', null);
  $('angemeldet').hidden = !an;
  $('abgemeldet').hidden = an;
  if (!an) status('Nicht verbunden');
  zeigeListe(); zeigeInfo();
}

function zeigeListe() {
  const e = eintraege();
  $('liste').replaceChildren(...e.map(o => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = o.text;
    const k = document.createElement('small');
    k.textContent = `${o.geraet} · ${zeit(o.zeit)}`;
    s.append(k);
    const b = document.createElement('button');
    b.textContent = 'Löschen';
    b.onclick = () => aendern({ id: o.id, typ: 'weg' });
    li.append(s, b);
    return li;
  }));
  $('leer').hidden = e.length > 0;
}

function zeigeInfo() {
  const t = lies('token', null), s = lies('letzterSync', null);
  const zeilen = [
    ['Gerät', `${geraet.name} (${geraet.id})`],
    ['Läuft als', modus()],
    ['Verbunden seit', t ? zeit(t.seit) : 'nicht verbunden'],
    ['Zugang erneuert', t?.erneuert ? zeit(t.erneuert) : '–'],
    ['Letzter Abgleich', s ? `${zeit(s.zeit)} (${s.dateien} Datei(en) im Ordner)` : '–'],
    ['Andere Geräte', Object.values(fremde).map(f => f.geraet).join(', ') || '–'],
    ['Einträge', String(eintraege().length)],
  ];
  $('info').replaceChildren(...zeilen.flatMap(([a, b]) => {
    const dt = document.createElement('dt'); dt.textContent = a;
    const dd = document.createElement('dd'); dd.textContent = b;
    return [dt, dd];
  }));
  $('log').replaceChildren(...lies('log', []).map(z => { const li = document.createElement('li'); li.textContent = z; return li; }));
}

// ---------- Ereignisse ----------

$('verbinden').onclick = async () => { location.href = await anmeldeAdresse(true); };
$('code-holen').onclick = async () => { window.open(await anmeldeAdresse(false), '_blank'); };
$('code-form').onsubmit = async ev => {
  ev.preventDefault();
  try { await codeEinloesen($('code').value); $('code').value = ''; zeigeAnsicht(); sync(); }
  catch (e) { log(`Verbinden fehlgeschlagen: ${e.message}`); }
};
$('neu').onsubmit = ev => {
  ev.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  aendern({ id: crypto.randomUUID(), typ: 'neu', text });
  $('text').value = '';
};
$('jetzt').onclick = () => sync();
$('trennen').onclick = () => {
  if (!confirm('Dropbox auf diesem Gerät trennen? Die Einträge bleiben in der Dropbox.')) return;
  localStorage.removeItem('token');
  log('Getrennt');
  zeigeAnsicht();
};
addEventListener('online', () => syncBald(0));
addEventListener('offline', () => status('Offline', 'warn'));
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncBald(0); });
setInterval(() => { if (!document.hidden) sync(); }, 30_000);

// ---------- Start ----------

(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const p = new URLSearchParams(location.search);
  if (p.has('code') || p.has('error')) {
    history.replaceState(null, '', RUECKSPRUNG);
    if (p.has('error')) log(`Dropbox: ${p.get('error_description') || p.get('error')}`);
    else {
      try { await codeEinloesen(p.get('code')); }
      catch (e) { log(`Verbinden fehlgeschlagen: ${e.message}`); }
    }
  }
  if (APP_KEY === 'APP_KEY_EINTRAGEN') log('App key fehlt noch');
  zeigeAnsicht();
  sync();
})();
