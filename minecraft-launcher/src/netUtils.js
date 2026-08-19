// ===========================================================================
// netUtils.js — Réseau durci pour le launcher (v2.1, corrige "Invalid IP")
// - safeLookup : résolution DNS système avec repli DNS-over-HTTPS (1.1.1.1 / 8.8.8.8)
// - fetchJSON / downloadFile : timeouts, limite de redirections, retries.
// NOTE : ceci ne change PAS le DNS utilisé par Minecraft/Java lui-même.
// ===========================================================================
const https = require('https');
const http = require('http');
const dns = require('dns');
const fs = require('fs');

const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const DOWNLOAD_RETRIES = 3;

// --- DNS-over-HTTPS -------------------------------------------------------
const DOH_PROVIDERS = [
    { ip: '1.1.1.1', path: '/dns-query?name=%s&type=A', headers: { accept: 'application/dns-json' } },
{ ip: '8.8.8.8', path: '/resolve?name=%s&type=A', headers: {} }
];

function dohQuery(provider, hostname) {
    return new Promise((resolve, reject) => {
        const req = https.get({
            host: provider.ip,
            servername: provider.ip,
            path: provider.path.replace('%s', encodeURIComponent(hostname)),
                              headers: { 'User-Agent': 'timerift-launcher', ...provider.headers },
                              timeout: 8000
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const answer = (json.Answer || []).find(a => a.type === 1);
                    if (answer && answer.data) resolve(answer.data);
                    else reject(new Error('DoH: pas de réponse A pour ' + hostname));
                } catch (e) { reject(e); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('DoH timeout')));
        req.on('error', reject);
    });
}

async function dohResolve(hostname) {
    let lastErr;
    for (const p of DOH_PROVIDERS) {
        try { return await dohQuery(p, hostname); }
        catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('DoH indisponible');
}

// ---------------------------------------------------------------------------
// safeLookup — compatible avec les deux formats attendus par Node :
//  - all: false (défaut historique)  → callback(err, address, family)
//  - all: true  (autoSelectFamily des Node récents) → callback(err, [{address, family}])
// C'était la cause du bug "Invalid IP" : on renvoyait une chaîne quand Node
// attendait un tableau. On passe désormais les options TELLES QUELLES au DNS
// système, et on adapte le format du repli DoH au format demandé.
// ---------------------------------------------------------------------------
function safeLookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    const wantAll = !!options.all;

    dns.lookup(hostname, options, (err, address, family) => {
        const systemOk = !err && address &&
        (!wantAll || (Array.isArray(address) && address.length > 0));
        if (systemOk) { callback(null, address, family); return; }

        // Repli DoH (routeur/FAI au DNS cassé)
        dohResolve(hostname)
        .then(ip => {
            if (wantAll) callback(null, [{ address: ip, family: 4 }]);
            else callback(null, ip, 4);
        })
        .catch(() => callback(err || new Error('Résolution impossible : ' + hostname)));
    });
}

// Diagnostic : compare DNS système vs DoH pour un hostname donné.
function dnsDiagnostic(hostname) {
    return new Promise((resolve) => {
        const result = { hostname, system: null, systemError: null, doh: null, dohError: null };
        dns.lookup(hostname, { family: 4 }, async (err, address) => {
            if (err) result.systemError = err.code || err.message;
            else result.system = address;
            try { result.doh = await dohResolve(hostname); }
            catch (e) { result.dohError = e.message; }
            resolve(result);
        });
    });
}

// --- HTTP durci ------------------------------------------------------------
function rawGet(url, redirectsLeft) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
            headers: { 'User-Agent': 'timerift-launcher' },
            lookup: safeLookup,
            timeout: REQUEST_TIMEOUT_MS
        }, (res) => {
            const code = res.statusCode;
            if ([301, 302, 307, 308].includes(code)) {
                res.resume();
                if (redirectsLeft <= 0) { reject(new Error('Trop de redirections pour ' + url)); return; }
                if (!res.headers.location) { reject(new Error('Redirection sans Location')); return; }
                rawGet(new URL(res.headers.location, url).href, redirectsLeft - 1).then(resolve).catch(reject);
                return;
            }
            resolve(res);
        });
        req.on('timeout', () => req.destroy(new Error('Timeout réseau (' + (REQUEST_TIMEOUT_MS / 1000) + 's) : ' + url)));
        req.on('error', reject);
    });
}

function fetchWithRedirect(url) {
    return rawGet(url, MAX_REDIRECTS);
}

function fetchJSON(url) {
    return fetchWithRedirect(url).then(res => new Promise((resolve, reject) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' pour ' + url)); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('JSON invalide : ' + e.message)); }
        });
        res.on('error', reject);
    }));
}

function downloadOnce(url, destPath, onProgress) {
    return fetchWithRedirect(url).then(res => new Promise((resolve, reject) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode + ' pour ' + url)); return; }
        const total = parseInt(res.headers['content-length'] || '0');
        let received = 0;
        const file = fs.createWriteStream(destPath);
        res.on('data', chunk => {
            received += chunk.length;
            if (onProgress && total) onProgress(received, total);
        });
            res.pipe(file);
            res.setTimeout(REQUEST_TIMEOUT_MS, () => res.destroy(new Error('Transfert bloqué : ' + url)));
            file.on('finish', () => file.close(resolve));
            const fail = (err) => { file.destroy(); fs.unlink(destPath, () => {}); reject(err); };
            file.on('error', fail);
            res.on('error', fail);
    }));
}

async function downloadFile(url, destPath, onProgress) {
    let lastErr;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt++) {
        try { return await downloadOnce(url, destPath, onProgress); }
        catch (err) {
            lastErr = err;
            if (attempt < DOWNLOAD_RETRIES) {
                await new Promise(r => setTimeout(r, 1500 * attempt));
            }
        }
    }
    throw new Error(lastErr.message + ' (après ' + DOWNLOAD_RETRIES + ' tentatives)');
}

module.exports = { safeLookup, dohResolve, dnsDiagnostic, fetchWithRedirect, fetchJSON, downloadFile };
