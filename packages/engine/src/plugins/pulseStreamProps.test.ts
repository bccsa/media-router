import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
    pipewireStreamProps,
    PIPEWIRE_RT_STREAM_PROPS,
    pulsePinnedStreamProps,
    PULSE_PINNED_STREAM_PROPS,
} from './pulseStreamProps.js';

describe('pulsePinnedStreamProps (#736)', () => {
    it('emits the WirePlumber pins as a single stream-properties clause', () => {
        expect(pulsePinnedStreamProps()).toBe(
            'stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true"',
        );
    });

    it('both pins are present — dont-fallback alone would make WirePlumber destroy a targetless stream', () => {
        expect(PULSE_PINNED_STREAM_PROPS['node.dont-fallback']).toBe('true');
        expect(PULSE_PINNED_STREAM_PROPS['node.linger']).toBe('true');
    });

    it('merges extra node properties after the pins, as (string) fields', () => {
        expect(pulsePinnedStreamProps({ 'node.latency': '2880/48000' })).toBe(
            'stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true,node.latency=(string)2880/48000"',
        );
    });

    it('an extra entry cannot silently drop a pin', () => {
        expect(pulsePinnedStreamProps({ 'node.linger': 'true' })).toBe(pulsePinnedStreamProps());
    });

    it('never names a node loop: a pulse stream runs inside pipewire-pulse, on its RT loop (B-88)', () => {
        expect(pulsePinnedStreamProps()).not.toContain('node.loop');
        expect(pulsePinnedStreamProps({ 'stream.capture.sink': 'true' })).not.toContain(
            'node.loop',
        );
    });
});

describe('pipewireStreamProps (B-88)', () => {
    it('the #736 pins, then the node on the RT data loop', () => {
        expect(PIPEWIRE_RT_STREAM_PROPS).toEqual({ 'node.loop.class': 'data.rt' });
        expect(pipewireStreamProps()).toBe(
            'stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true,node.loop.class=(string)data.rt"',
        );
    });

    it('merges extra node properties after the pins and the loop class', () => {
        expect(
            pipewireStreamProps({
                'node.latency': '2880/48000',
                'node.name': 'MR_PW_ain-1',
                'node.autoconnect': 'false',
            }),
        ).toBe(
            'stream-properties="props,node.dont-fallback=(string)true,node.linger=(string)true,node.loop.class=(string)data.rt,node.latency=(string)2880/48000,node.name=(string)MR_PW_ain-1,node.autoconnect=(string)false"',
        );
    });

    it('an extra entry cannot silently drop a pin or the loop class', () => {
        expect(pipewireStreamProps({ 'node.linger': 'true', 'node.loop.class': 'data.rt' })).toBe(
            pipewireStreamProps(),
        );
    });
});

describe('every PipeWire client element in the tree takes its own helper (B-88)', () => {
    const root = join(__dirname, '..', '..', '..', '..');
    const sources = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const path = join(dir, e.name);
            if (e.isDirectory())
                return ['node_modules', 'testing'].includes(e.name) ? [] : sources(path);
            return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
        });
    // Every package's sources and every plugin's engine half, without tests and test helpers.
    const dirs = ['packages', 'plugins'].flatMap((top) =>
        readdirSync(join(root, top))
            .map((name) => join(root, top, name, top === 'packages' ? 'src' : 'engine'))
            .filter((dir) => existsSync(dir)),
    );
    const text = dirs
        .flatMap(sources)
        .map((f) => [relative(root, f), readFileSync(f, 'utf8')] as const);

    // A launch-string clause opens a template literal on the element's factory (comment lines
    // name elements too) and runs to the end of its statement or the next element; its
    // stream-properties helper must be in it.
    const OPEN = /`(pulsesrc|pulsesink|pipewiresrc|pipewiresink)\b/g;
    const HELPER = /\$\{(pulsePinnedStreamProps|pipewireStreamProps)\(/;
    const elements = text.flatMap(([file, src]) =>
        [...src.matchAll(OPEN)]
            .filter((m) => {
                const before = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
                return !/^\s*(\*|\/\*)/.test(before) && !before.includes('//');
            })
            .map((m) => {
                const tail = src.slice(m.index! + m[0].length);
                const ends = [tail.indexOf(';'), tail.search(OPEN)].filter((i) => i >= 0);
                const clause = tail.slice(0, ends.length ? Math.min(...ends) : tail.length);
                const line = src.slice(0, m.index).split('\n').length;
                return { at: `${file}:${line}`, element: m[1], helper: HELPER.exec(clause)?.[1] };
            }),
    );

    it('finds the elements at all (a vacuous pass is not a pass)', () => {
        const pipewire = elements.filter((e) => e.element.startsWith('pipewire'));
        expect(pipewire.map((e) => e.at.split(':')[0]).sort()).toEqual([
            'plugins/audio-encoder/engine/AudioEncoderModule.ts',
            'plugins/audio-input-302m/engine/AudioInput302mModule.ts',
        ]);
        // GstPluginBase's VU tap, audio-input, audio-output, audio-decoder, audio-output-302m and
        // audio-dynamics' five.
        expect(elements.length - pipewire.length).toBeGreaterThanOrEqual(10);
    });

    it('pulsesrc and pulsesink keep the pins alone; pipewiresrc and pipewiresink take the RT loop', () => {
        const want = (element: string) =>
            element.startsWith('pulse') ? 'pulsePinnedStreamProps' : 'pipewireStreamProps';
        expect(elements.filter((e) => e.helper !== want(e.element))).toEqual([]);
    });

    it('no other source names a node loop in code, so no pulse stream gains one', () => {
        const code = (src: string) => src.split('\n').filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l));
        const naming = text
            .filter(([, src]) => code(src).some((l) => l.includes('node.loop.')))
            .map(([f]) => f);
        expect(naming).toEqual(['packages/engine/src/plugins/pulseStreamProps.ts']);
    });
});
