// Loopback HTTP endpoint the hook reporter posts to. It listens on 127.0.0.1
// only and checks a per-run token, so a web page in a browser cannot post fake
// sessions to it.
'use strict';
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 64 * 1024;

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * onEvent receives each parsed event. listen() tries `port` and the next
 * `tries - 1` ports and resolves with the one it got.
 */
function createServer({ token, onEvent }) {
  let port = 0;
  const server = http.createServer((req, res) => {
    const reply = (code) => { res.writeHead(code); res.end(); };
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(403);
    if (req.method !== 'POST' || req.url !== '/event') return reply(404);
    if (!tokenMatches(req.headers['x-cs-token'], token)) return reply(403);
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reply(413); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let ev;
      try { ev = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400); }
      if (!ev || typeof ev.event !== 'string' || !Number.isInteger(ev.pid)) return reply(400);
      reply(204);
      try { onEvent(ev); } catch (e) { console.error('event handler failed:', e); }
    });
  });

  function listenOn(p) {
    return new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    });
  }

  return {
    async listen(firstPort, tries = 10) {
      let lastErr;
      for (let i = 0; i < tries; i++) {
        try {
          port = await listenOn(firstPort === 0 ? 0 : firstPort + i);
          return port;
        } catch (e) {
          // EACCES: the port is reserved or not ours to bind.
          if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
          lastErr = e;
        }
      }
      throw lastErr;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createServer, newToken, tokenMatches };
