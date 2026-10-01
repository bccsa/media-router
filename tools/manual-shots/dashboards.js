// Screenshots for docs/manuals/dashboards.md against a test router (manager + router on one box).
// Makes its own demo dashboards and deletes them after. Crops the manager's header bar (it shows
// the box's address and build) and crops dialogs to the dialog.
//
//   MR_HOST=10.9.16.103 CHROMIUM=/usr/lib/chromium/chromium node tools/manual-shots/dashboards.js
//
// Needs `puppeteer-core` (npm i puppeteer-core in this folder) and a Chromium.
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const HOST = process.env.MR_HOST ?? '10.9.16.103';
const MANAGER = `http://${HOST}:8080`;
const ROUTER = `http://${HOST}:8081`;
const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'docs/manuals/images/dashboards');
const CLI = path.join(ROOT, 'tools/tree-cli/mr_tree.js');
const HEADER = 48; // the manager UI's top bar
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tree = (...args) => execFileSync('node', [CLI, '--url', MANAGER, ...args]).toString().split('\n')[0];
const call = (at, method, args) => JSON.parse(tree('call', at, method, JSON.stringify(args)));

const MOD = '/modules/audio-mixer-n1out01';
const studio = {
    name: 'Studio A', cols: 16, rows: 9, scroll: false, zoom: false, locked: false, theme: 'dark',
    widgets: [
        { id: 'frame', type: 'label', x: 0, y: 0, w: 6, h: 9, options: { text: 'Presenter mic', frame: true } },
        { id: 'fader', type: 'fader', x: 0, y: 1, w: 2, h: 6, bind: `${MOD}/settings/volume`, options: { label: 'Level' } },
        { id: 'vu', type: 'vu', x: 2, y: 1, w: 2, h: 6, bind: `${MOD}/vu`, options: { label: 'Levels' } },
        { id: 'mute', type: 'latch', x: 4, y: 1, w: 2, h: 3, bind: `${MOD}/settings/audioEnabled`, options: { litWhen: 'false', litText: 'MUTED', unlitText: 'LIVE' } },
        { id: 'health', type: 'light', x: 4, y: 4, w: 2, h: 2, bind: `${MOD}/health`, options: { label: 'Health' } },
        { id: 'restart', type: 'button', x: 0, y: 7, w: 6, h: 2, action: { kind: 'call', path: MOD, method: 'restart' }, options: { text: 'Restart mic', confirm: true } },
        { id: 'cpu', type: 'trend', x: 6, y: 0, w: 10, h: 5, binds: ['/system/cpu', '/system/temp'], options: { window: 1 } },
        { id: 'host', type: 'readout', x: 6, y: 5, w: 5, h: 2, bind: '/info/name', options: { label: 'Router' } },
        { id: 'gauge', type: 'gauge', x: 11, y: 5, w: 5, h: 2, bind: '/system/mem', options: { label: 'Memory' } },
        {
            id: 'auto', type: 'button', x: 6, y: 7, w: 10, h: 2, options: { text: 'Mic down if loud', confirm: true },
            script: { steps: [{ do: 'if', cond: { op: '>', a: { read: `${MOD}/settings/volume` }, b: { lit: 100 } }, then: [{ do: 'write', path: `${MOD}/settings/volume`, value: { lit: 80 } }], else: [{ do: 'wait', seconds: { lit: 1 } }] }] },
        },
    ],
};
const states = {
    name: 'States', cols: 8, rows: 4, scroll: false, zoom: false, locked: false, theme: 'dark',
    widgets: [
        { id: 'ok', type: 'fader', x: 0, y: 0, w: 2, h: 4, bind: `${MOD}/settings/volume`, options: { label: 'Present' } },
        { id: 'gone', type: 'fader', x: 2, y: 0, w: 2, h: 4, bind: '/modules/removed-module/settings/volume', options: { label: 'Removed module' } },
        { id: 'ro', type: 'readout', x: 4, y: 0, w: 4, h: 2, bind: '/system/cpu', options: { label: 'CPU' } },
    ],
};
const fleet = {
    name: 'Fleet overview', cols: 12, rows: 6, scroll: false, zoom: false, locked: false, theme: 'light',
    widgets: [
        { id: 'cpu', type: 'trend', x: 0, y: 0, w: 12, h: 4, binds: ['/engines/local/system/cpu'], options: { window: 1 } },
        { id: 'h', type: 'light', x: 0, y: 4, w: 4, h: 2, bind: `/engines/local${MOD}/health`, options: { label: 'Presenter mic' } },
    ],
};

const made = [];
async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    made.push(['/engines/local/dashboards', call('/engines/local/dashboards', 'save', { dashboard: studio }).id]);
    made.push(['/engines/local/dashboards', call('/engines/local/dashboards', 'save', { dashboard: states }).id]);
    made.push(['/dashboards', call('/dashboards', 'save', { dashboard: fleet }).id]);
    const [studioId, statesId, fleetId] = made.map((m) => m[1]);

    const browser = await puppeteer.launch({
        executablePath: process.env.CHROMIUM ?? '/usr/lib/chromium/chromium',
        headless: true,
        args: ['--no-sandbox', '--no-first-run', '--disable-gpu', '--disable-dev-shm-usage'],
        userDataDir: fs.mkdtempSync('/tmp/mr-shots-'),
        defaultViewport: { width: 1280, height: 800 },
    });
    const page = await browser.newPage();
    try {
        const go = async (url, wait = 3000) => {
            await page.goto(url, { waitUntil: 'networkidle2' });
            await sleep(wait);
        };
        const click = (text, selector = 'button') =>
            page.evaluate((t, sel) => {
                const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null && e.textContent.trim().startsWith(t));
                if (!el) throw new Error(`no ${sel} "${t}"`);
                el.click();
            }, text, selector);
        /** The page below the manager's header, or a whole router page. */
        const shotPage = async (name, manager = true) => {
            const vp = page.viewport();
            await page.screenshot({ path: `${OUT}/${name}.png`, clip: manager ? { x: 0, y: HEADER, width: vp.width, height: vp.height - HEADER } : undefined });
            console.log('shot', name);
        };
        /** Just the element (a dialog), with a margin. */
        const shotOf = async (name, selector, pad = 16) => {
            const box = await (await page.$(selector)).boundingBox();
            const vp = page.viewport();
            const x = Math.max(0, box.x - pad);
            const y = Math.max(0, box.y - pad);
            await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x, y, width: Math.min(vp.width - x, box.width + 2 * pad), height: Math.min(vp.height - y, box.height + 2 * pad) } });
            console.log('shot', name);
        };
        const dialog = '.fixed.inset-0.z-50 .relative.z-10';
        const esc = async () => {
            await page.keyboard.press('Escape');
            await sleep(400);
        };
        const select = async (index) => {
            const b = await (await page.$$('.eo-box'))[index].boundingBox();
            await page.mouse.click(b.x + 8, b.y + 8);
            await sleep(600);
        };

        await go(`${MANAGER}/dashboards`);
        await shotPage('01-manager-dashboards');
        await go(`${MANAGER}/engines/local/dashboards`);
        await shotPage('02-router-dashboards');
        await go(`${MANAGER}/engines/local/dashboards/${studioId}`, 50000);
        await shotPage('03-dashboard');
        await go(`${ROUTER}/d/`);
        await page.screenshot({ path: `${OUT}/04-viewer-list.png`, clip: { x: 0, y: 0, width: 540, height: 330 } });
        console.log('shot 04-viewer-list');
        await go(`${ROUTER}/d/Studio%20A`, 50000);
        await shotPage('05-viewer', false);
        await click('Restart mic', '.bt');
        await sleep(600);
        await shotOf('06-confirm', '.dv-dialog');
        await click('Cancel');
        await sleep(400);
        await page.click('.dv-dot-hit');
        await sleep(500);
        await page.screenshot({ path: `${OUT}/07-dot.png`, clip: { x: 760, y: 0, width: 520, height: 140 } });
        console.log('shot 07-dot');
        await go(`${MANAGER}/engines/local/dashboards/${statesId}`, 5000);
        await shotPage('08-missing');

        await go(`${MANAGER}/engines/local/dashboards/${studioId}?edit=1`, 4000);
        await shotPage('09-editor');
        await select(1);
        await shotPage('10-inspector');
        await click('Choose value…');
        await sleep(800);
        await click('N1 Out 1 meter', `${dialog} *`).catch(() => click('N1 Out 1', `${dialog} *`));
        await sleep(800);
        await shotOf('11-value-picker', dialog);
        await esc();
        await click('Settings');
        await sleep(600);
        await shotOf('12-settings', dialog);
        await esc();
        await page.setViewport({ width: 1280, height: 1100 });
        await sleep(500);
        await select(9);
        await click('Open editor…');
        await sleep(800);
        await shotOf('13-button-actions', dialog);
        await click('Done');
        await page.setViewport({ width: 1280, height: 800 });
        await sleep(500);
        await select(1);
        await click('Duplicate for…');
        await sleep(800);
        await shotOf('14-duplicate-for', dialog);
        await esc();
        await select(7);
        await page.keyboard.press('ArrowDown');
        await sleep(300);
        const now = JSON.parse(tree('get', `/engines/local/dashboards/${studioId}`)).value;
        call('/engines/local/dashboards', 'save', { id: studioId, baseRev: now.rev, dashboard: studio });
        await click('Save');
        await sleep(1200);
        await shotOf('15-conflict', dialog);
        await click('Load theirs');
        await sleep(800);

        await go(`${MANAGER}/engines/local/dashboards`);
        const row = await page.evaluateHandle(() => [...document.querySelectorAll('div')].filter((d) => d.textContent.includes('Studio A') && d.textContent.includes('Copy to')).at(-1));
        await row.evaluate((r) => [...r.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Copy to')).click());
        await sleep(800);
        await shotOf('16-copy-to', dialog);
        await esc();
        await go(`${MANAGER}/dashboards/${fleetId}`, 45000);
        await shotPage('17-manager-dashboard-light');
        await click('History');
        await sleep(800);
        await shotOf('18-history', dialog);
    } finally {
        await browser.close();
    }
}

main()
    .catch((e) => {
        console.error('FAILED', e.message);
        process.exitCode = 1;
    })
    .finally(() => {
        for (const [at, id] of made) {
            try {
                tree('call', `${at}/${id}`, 'delete', '{}');
            } catch {}
        }
        console.log('demo dashboards removed');
    });
