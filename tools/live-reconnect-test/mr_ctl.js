#!/usr/bin/env node
// Minimal on-box manager client for the live reconnect test (runs on a
// media-router box next to its LOCAL manager on :8080).
//
//   node mr_ctl.js state  <engineId> <moduleId>        → JSON state of one module
//   node mr_ctl.js enable <engineId> <moduleId> true|false
//
// Speaks the tree protocol (ADR-0024) through ../tree-cli/tree.js: a
// snapshot of /engines/<id>/modules/<id>, or a write to its `enabled`.
'use strict';
const { connect } = require('../tree-cli/tree.js');

const [cmd, engineId, moduleId, arg] = process.argv.slice(2);
if (!cmd || !engineId || !moduleId) {
    console.error('usage: mr_ctl.js state|enable <engineId> <moduleId> [true|false]');
    process.exit(2);
}
const url = process.env.MR_MANAGER_URL || 'http://127.0.0.1:8080';
const base = `/engines/${engineId}/modules/${moduleId}`;

async function main() {
    const t = connect(url);
    const timer = setTimeout(() => {
        console.error('timeout talking to the manager');
        process.exit(1);
    }, 8000);
    await t.ready;
    if (cmd === 'state') {
        const [op] = await t.sub([base]);
        if (!op) throw new Error(`no module ${moduleId} on ${engineId}`);
        console.log(JSON.stringify(op.value));
    } else if (cmd === 'enable') {
        const { rejected } = await t.write([{ op: 'replace', path: `${base}/enabled`, value: arg === 'true' }]);
        if (rejected.length > 0) throw new Error(rejected[0].reason);
    } else {
        throw new Error(`unknown command ${cmd}`);
    }
    clearTimeout(timer);
    t.close();
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
