#!/usr/bin/env node
// Minimal on-box manager client for the live reconnect test (runs on a
// media-router box next to its LOCAL manager on :8080).
//
//   node mr_ctl.js state  <engineId> <moduleId>        → JSON runtime state of one module
//   node mr_ctl.js enable <engineId> <moduleId> true|false
//
// Uses the same Socket.IO surface the manager UI uses: `watch:engine` to get
// `engine:state` (ModuleRuntimeState per module) and `patch` with a JSON-patch
// op on /modules/<id>/enabled. socket.io-client is resolved from the installed
// packages, so nothing extra has to be shipped.
'use strict';
const path = require('path');
const roots = ['/opt/media-router/packages/engine', '/opt/media-router/packages/manager', process.cwd()];
let ioPath = null;
for (const r of roots) {
    try { ioPath = require.resolve('socket.io-client', { paths: [r] }); break; } catch (_e) { /* next */ }
}
if (!ioPath) { console.error('socket.io-client not found'); process.exit(2); }
const { io } = require(ioPath);

const [cmd, engineId, moduleId, arg] = process.argv.slice(2);
if (!cmd || !engineId || !moduleId) {
    console.error('usage: mr_ctl.js state|enable <engineId> <moduleId> [true|false]');
    process.exit(2);
}
const url = process.env.MR_MANAGER_URL || 'http://127.0.0.1:8080';
const sock = io(url, { transports: ['websocket'], reconnection: false, timeout: 5000 });
const die = (msg, code = 1) => { console.error(msg); sock.close(); process.exit(code); };
const timer = setTimeout(() => die('timeout talking to the manager'), 8000);

sock.on('connect_error', (e) => die(`connect_error: ${e.message}`));
sock.on('connect', () => {
    if (cmd === 'state') {
        sock.on('engine:state', (msg) => {
            if (!msg || msg.engineId !== engineId) return;
            const st = (msg.state || {})[moduleId];
            if (st === undefined) return; // partial delta without our module — keep waiting
            clearTimeout(timer);
            console.log(JSON.stringify(st));
            sock.close();
            process.exit(0);
        });
        sock.emit('watch:engine', { engineId });
    } else if (cmd === 'enable') {
        const value = arg === 'true';
        sock.emit('patch', { engineId, ops: [{ op: 'replace', path: `/modules/${moduleId}/enabled`, value }] });
        setTimeout(() => { clearTimeout(timer); sock.close(); process.exit(0); }, 400);
    } else {
        die(`unknown command ${cmd}`, 2);
    }
});
