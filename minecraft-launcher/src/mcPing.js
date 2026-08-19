// ===========================================================================
// mcPing.js — Server List Ping (protocole Minecraft moderne, 1.7+).
// Sert à afficher « serveur en ligne, 12/40 joueurs » dans le launcher.
// Aucune dépendance : handshake + status request en TCP brut.
// ===========================================================================
const net = require('net');
const { safeLookup } = require('./netUtils');

const PROTOCOL_VERSION = 767;   // 1.21.x — le serveur l'ignore pour un simple status

// --- VarInt ---------------------------------------------------------------
function writeVarInt(value) {
    const bytes = [];
    let v = value >>> 0;
    do {
        let b = v & 0x7f;
        v >>>= 7;
        if (v !== 0) b |= 0x80;
        bytes.push(b);
    } while (v !== 0);
    return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
    let result = 0, shift = 0, pos = offset;
    while (true) {
        if (pos >= buf.length) return null;              // paquet incomplet
        const b = buf[pos++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: result >>> 0, size: pos - offset };
        shift += 7;
        if (shift > 35) throw new Error('VarInt trop long');
    }
}

function packet(id, payload) {
    const body = Buffer.concat([writeVarInt(id), payload]);
    return Buffer.concat([writeVarInt(body.length), body]);
}

function writeString(str) {
    const b = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(b.length), b]);
}

// --- MOTD : le serveur renvoie soit une chaîne, soit un objet chat ---------
function flattenMotd(desc) {
    if (desc == null) return '';
    if (typeof desc === 'string') return desc;
    let out = desc.text || '';
    if (Array.isArray(desc.extra)) for (const part of desc.extra) out += flattenMotd(part);
    return out;
}

/**
 * Interroge un serveur Minecraft.
 * @returns {Promise<{online:boolean, players?:{online:number,max:number}, version?:string, motd?:string, latency?:number, error?:string}>}
 */
function pingServer(host, port = 25565, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const started = Date.now();
        let settled = false;
        const done = (result) => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (e) {}
            resolve(result);
        };

        const socket = net.createConnection({ host, port, lookup: safeLookup, timeout: timeoutMs });
        let chunks = Buffer.alloc(0);

        socket.on('connect', () => {
            const handshake = packet(0x00, Buffer.concat([
                writeVarInt(PROTOCOL_VERSION),                   // ignorée par le serveur en mode status
                                                                 writeString(host),
                                                                 Buffer.from([(port >> 8) & 0xff, port & 0xff]),
                                                                 writeVarInt(1)                                   // next state : status
            ]));
            socket.write(handshake);
            socket.write(packet(0x00, Buffer.alloc(0)));         // status request
        });

        socket.on('data', (data) => {
            chunks = Buffer.concat([chunks, data]);
            try {
                const len = readVarInt(chunks, 0);
                if (!len) return;                                 // longueur pas encore complète
                const total = len.size + len.value;
                if (chunks.length < total) return;                // corps incomplet, on attend

                const idInfo = readVarInt(chunks, len.size);
                if (!idInfo) return;
                const strLen = readVarInt(chunks, len.size + idInfo.size);
                if (!strLen) return;

                const start = len.size + idInfo.size + strLen.size;
                const json = JSON.parse(chunks.slice(start, start + strLen.value).toString('utf8'));

                done({
                    online: true,
                    players: {
                        online: json.players ? json.players.online : 0,
                        max: json.players ? json.players.max : 0
                    },
                    version: json.version ? json.version.name : null,
                       motd: flattenMotd(json.description).replace(/§./g, '').trim(),
                       latency: Date.now() - started
                });
            } catch (e) {
                done({ online: false, error: 'réponse illisible' });
            }
        });

        socket.on('timeout', () => done({ online: false, error: 'timeout' }));
        socket.on('error', (e) => done({ online: false, error: e.code || e.message }));
        socket.on('close', () => done({ online: false, error: 'connexion fermée' }));
    });
}

module.exports = { pingServer };
