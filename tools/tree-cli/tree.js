// Minimal tree-protocol client (ADR-0024) for on-box tools. socket.io-client
// is resolved from the installed packages, so nothing extra is shipped.
'use strict';
const path = require('path');

const PROTOCOL = 1;

function loadIo() {
    const roots = [
        '/opt/media-router/packages/manager-ui',
        '/opt/media-router/packages/engine',
        path.resolve(__dirname, '../../packages/manager-ui'),
        process.cwd(),
    ];
    for (const r of roots) {
        try {
            return require(require.resolve('socket.io-client', { paths: [r] })).io;
        } catch (_e) {
            /* next */
        }
    }
    throw new Error('socket.io-client not found');
}

/** Connect to a manager (default) or a router (`socketPath: '/tree'`). */
function connect(url, socketPath) {
    const io = loadIo();
    const sock = io(url, {
        path: socketPath || undefined,
        auth: { proto: PROTOCOL },
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
    });
    const ready = new Promise((resolve, reject) => {
        sock.on('connect', resolve);
        sock.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));
    });
    const request = (event, payload) =>
        new Promise((resolve, reject) =>
            sock.emit(event, payload, (ack) => (ack && ack.ok ? resolve(ack.data) : reject(new Error((ack && ack.error) || 'no reply')))),
        );
    let writeId = 0;
    return {
        ready,
        sub: (patterns) => request('sub', { patterns }).then((d) => d.ops),
        write: (ops) => request('write', { id: ++writeId, ops }),
        call: (p, method, args) => request('call', { path: p, method, args }),
        onFrame: (fn) => sock.on('tree', (f) => fn(f.ops)),
        close: () => sock.close(),
    };
}

module.exports = { connect, PROTOCOL };
