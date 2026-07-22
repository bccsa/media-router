import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebRtcClientModule } from './WebRtcClientModule.js';

function createServices(instanceId = 'webrtc-client-test') {
    return {
        pipeWire: {} as any,
        mediaRouter: {} as any,
        processManager: {} as any,
        deviceProviders: {} as any,
        instanceId,
    };
}

async function createModule(config: Record<string, unknown> = {}, instanceId?: string) {
    const module = new WebRtcClientModule();
    await module.onInit(config, createServices(instanceId));
    return module;
}

// Track modules that bound the port so we always release it between tests.
const started: WebRtcClientModule[] = [];
afterEach(async () => {
    while (started.length) {
        const m = started.pop()!;
        await m.onStop().catch(() => {});
    }
});

async function start(module: WebRtcClientModule) {
    started.push(module);
    await module.onStart();
    return module;
}

const CONFIG_URL = 'http://127.0.0.1:2000/config.json';

describe('WebRtcClientModule', () => {
    describe('buildPipeline', () => {
        it('returns null — pure service module, no GStreamer pipeline', async () => {
            const module = await createModule();
            expect(module.buildPipeline({})).toBeNull();
        });
    });

    describe('config mapping (/config.json shape)', () => {
        it('maps clients to the V1.3 webRtcAudioStreams shape', async () => {
            const module = await start(
                await createModule({
                    displayName: 'OCC Streams',
                    clients: [
                        { name: 'English', description: 'EN feed', url: 'https://mtx/whep/en', countryCode: 'gb' },
                        { name: 'Zulu', description: 'ZU feed', url: 'https://mtx/whep/zu', countryCode: 'za' },
                    ],
                }),
            );

            const res = await fetch(CONFIG_URL);
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('application/json');

            const body = await res.json();
            expect(body).toEqual({
                displayName: 'OCC Streams',
                webRtcAudioStreams: [
                    { id: 'client-0', name: 'English', url: 'https://mtx/whep/en', countryCode: 'gb', note: 'EN feed' },
                    { id: 'client-1', name: 'Zulu', url: 'https://mtx/whep/zu', countryCode: 'za', note: 'ZU feed' },
                ],
            });
        });

        it('defaults to the fallback title and an empty stream list', async () => {
            const module = await start(await createModule({}));
            const body = await (await fetch(CONFIG_URL)).json();
            expect(body).toEqual({ displayName: 'Audio Streaming Service', webRtcAudioStreams: [] });
        });

        it('returns 404 for non-config paths', async () => {
            await start(await createModule({}));
            const res = await fetch('http://127.0.0.1:2000/');
            expect(res.status).toBe(404);
        });
    });

    describe('lifecycle', () => {
        it('binds on 127.0.0.1:2000 and reports running/ok', async () => {
            const module = await start(await createModule({}));
            const state = module.getState();
            expect(state.running).toBe(true);
            expect(state.health).toBe('ok');
        });

        it('closes the server on stop (connection refused afterwards)', async () => {
            const module = await createModule({});
            await module.onStart();
            await module.onStop();
            await expect(fetch(CONFIG_URL)).rejects.toBeDefined();
            expect(module.getState().running).toBe(false);
        });
    });

    describe('live config update', () => {
        it('serves the new stream list without a restart', async () => {
            const module = await start(await createModule({ clients: [] }));
            expect((await (await fetch(CONFIG_URL)).json()).webRtcAudioStreams).toEqual([]);

            await module.onLiveConfigUpdate({
                clients: [{ name: 'New', description: '', url: 'https://mtx/whep/new', countryCode: 'us' }],
            });

            const body = await (await fetch(CONFIG_URL)).json();
            expect(body.webRtcAudioStreams).toEqual([
                { id: 'client-0', name: 'New', url: 'https://mtx/whep/new', countryCode: 'us', note: '' },
            ]);
        });
    });

    describe('single-instance / port-conflict handling', () => {
        it('second binder errors without self-disabling (no selfStop); first stays healthy', async () => {
            const first = await start(await createModule({}, 'webrtc-client-a'));

            const second = await createModule({}, 'webrtc-client-b');
            const selfStop = vi.fn();
            second.on('selfStop', selfStop);
            started.push(second);
            await second.onStart();

            // A port conflict (duplicate or foreign occupant) must NOT disable the
            // module — it only errors and stays stopped.
            expect(selfStop).not.toHaveBeenCalled();
            expect(second.getState().health).toBe('error');
            expect(second.getState().running).toBe(false);

            // First instance is unaffected and keeps serving.
            expect(first.getState().health).toBe('ok');
            expect((await fetch(CONFIG_URL)).status).toBe(200);
        });
    });
});
