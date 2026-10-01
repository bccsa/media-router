#!/usr/bin/env node
// Tree CLI (ADR-0024) — a manager on :8080, or a router with --path /tree on :8081.
//
//   node mr_tree.js [--url U] [--path /tree] get   <pattern>...
//   node mr_tree.js [--url U] [--path /tree] sub   <pattern>... [--secs N]
//   node mr_tree.js [--url U] [--path /tree] write <path> <json> [add|replace|remove]
//   node mr_tree.js [--url U] [--path /tree] call  <path> <method> [json-args]
'use strict';
const { connect } = require('./tree.js');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
    const i = argv.indexOf(name);
    if (i < 0) return dflt;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
};
const url = flag('--url', process.env.MR_TREE_URL || 'http://127.0.0.1:8080');
const socketPath = flag('--path', undefined);
const secs = Number(flag('--secs', '0'));
const [cmd, ...rest] = argv;
const print = (v) => console.log(JSON.stringify(v));

async function main() {
    const t = connect(url, socketPath);
    await t.ready;
    switch (cmd) {
        case 'get':
            for (const op of await t.sub(rest)) print({ path: op.path, value: op.value });
            break;
        case 'sub': {
            t.onFrame((ops) => ops.forEach(print));
            (await t.sub(rest)).forEach(print);
            await new Promise((r) => (secs > 0 ? setTimeout(r, secs * 1000) : undefined));
            break;
        }
        case 'write': {
            const [p, json, op = 'replace'] = rest;
            print(await t.write([op === 'remove' ? { op, path: p } : { op, path: p, value: JSON.parse(json) }]));
            break;
        }
        case 'call': {
            const [p, method, json] = rest;
            print(await t.call(p, method, json ? JSON.parse(json) : undefined));
            break;
        }
        default:
            throw new Error('usage: mr_tree.js get|sub|write|call …');
    }
    t.close();
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
