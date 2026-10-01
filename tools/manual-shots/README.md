# Manual screenshots

`dashboards.js` takes the screenshots in `docs/manuals/images/dashboards/`
against one test router that runs its own manager (default `10.9.16.103`):
it makes demo dashboards, shoots 18 pages and dialogs at 1280 × 800 (the
button editor at 1280 × 1100), crops the manager's header bar (it shows the
box's address and build) and crops dialogs to the dialog, then deletes the
demos.

```sh
cd tools/manual-shots && npm i puppeteer-core
MR_HOST=10.9.16.103 CHROMIUM=/usr/lib/chromium/chromium node dashboards.js
```

The demo values come from that router's modules (`audio-mixer-n1out01`);
on another box, change `MOD` at the top of the script. The trend shots wait
about 50 s so the graphs have a minute of data.
