import { describe, it, expect, beforeEach } from 'vitest';
import { PortRegistry } from './PortRegistry.js';
import type { ModulePort } from '@media-router/shared-types';

describe('PortRegistry', () => {
    let registry: PortRegistry;

    beforeEach(() => {
        registry = new PortRegistry();
    });

    describe('register / unregister', () => {
        it('registers ports for a module', () => {
            const ports: ModulePort[] = [
                { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
            ];
            registry.register('mod-1', ports);
            expect(registry.get('mod-1', 'out')).toEqual(ports[0]);
        });

        it('returns undefined for unregistered module', () => {
            expect(registry.get('missing', 'out')).toBeUndefined();
        });

        it('returns undefined for unregistered port', () => {
            registry.register('mod-1', [
                { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
            ]);
            expect(registry.get('mod-1', 'missing')).toBeUndefined();
        });

        it('unregisters a module', () => {
            registry.register('mod-1', [
                { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
            ]);
            registry.unregister('mod-1');
            expect(registry.get('mod-1', 'out')).toBeUndefined();
        });

        it('unregisterAll clears all modules', () => {
            registry.register('a', [
                { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
            ]);
            registry.register('b', [
                { id: 'in', direction: 'input', streamType: 'audio/pcm', label: 'In' },
            ]);
            registry.unregisterAll();
            expect(registry.get('a', 'out')).toBeUndefined();
            expect(registry.get('b', 'in')).toBeUndefined();
        });

        it('getAll returns all ports for a module', () => {
            const ports: ModulePort[] = [
                { id: 'out', direction: 'output', streamType: 'audio/pcm', label: 'Out' },
                { id: 'in', direction: 'input', streamType: 'muxed/mpegts', label: 'In' },
            ];
            registry.register('mod-1', ports);
            expect(registry.getAll('mod-1')).toHaveLength(2);
        });

        it('getAll returns empty for unknown module', () => {
            expect(registry.getAll('missing')).toEqual([]);
        });
    });

    describe('getConnectionCount', () => {
        it('counts connections on a specific output port', () => {
            const connections = [
                {
                    sourceModuleId: 'enc',
                    sourcePortId: 'mpegts-out',
                    sinkModuleId: 'dec-1',
                    sinkPortId: 'mpegts-in',
                },
                {
                    sourceModuleId: 'enc',
                    sourcePortId: 'mpegts-out',
                    sinkModuleId: 'dec-2',
                    sinkPortId: 'mpegts-in',
                },
                {
                    sourceModuleId: 'other',
                    sourcePortId: 'out',
                    sinkModuleId: 'enc',
                    sinkPortId: 'audio-in',
                },
            ];
            expect(registry.getConnectionCount('enc', 'mpegts-out', connections)).toBe(2);
        });

        it('counts connections on a specific input port', () => {
            const connections = [
                {
                    sourceModuleId: 'enc-1',
                    sourcePortId: 'out',
                    sinkModuleId: 'dec',
                    sinkPortId: 'in',
                },
                {
                    sourceModuleId: 'enc-2',
                    sourcePortId: 'out',
                    sinkModuleId: 'dec',
                    sinkPortId: 'in',
                },
            ];
            expect(registry.getConnectionCount('dec', 'in', connections)).toBe(2);
        });

        it('returns 0 for port with no connections', () => {
            const connections = [
                { sourceModuleId: 'a', sourcePortId: 'out', sinkModuleId: 'b', sinkPortId: 'in' },
            ];
            expect(registry.getConnectionCount('c', 'out', connections)).toBe(0);
        });

        it('returns 0 for empty connections', () => {
            expect(registry.getConnectionCount('a', 'out', [])).toBe(0);
        });
    });

    describe('validateCompatibility', () => {
        it('allows same stream type', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/pcm',
                label: 'Out',
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'audio/pcm',
                label: 'In',
            };
            expect(registry.validateCompatibility(src, sink).compatible).toBe(true);
        });

        it('allows the TS family both ways (audio/302m is valid MPEG-TS)', () => {
            const mk = (streamType: 'audio/302m' | 'muxed/mpegts', direction: 'input' | 'output'): ModulePort => ({
                id: direction === 'output' ? 'out' : 'in',
                direction,
                streamType,
                label: 'p',
            });
            // 302M rendition → SRT/RIST/UDP transport input
            expect(
                registry.validateCompatibility(mk('audio/302m', 'output'), mk('muxed/mpegts', 'input'))
                    .compatible,
            ).toBe(true);
            // srt/rist-input TS → 302M mixing pin
            expect(
                registry.validateCompatibility(mk('muxed/mpegts', 'output'), mk('audio/302m', 'input'))
                    .compatible,
            ).toBe(true);
        });

        it('acceptsStreamTypes opts an input out of TS-family leniency (ts-splitter)', () => {
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'muxed/mpegts',
                label: 'MPEG-TS In',
                acceptsStreamTypes: ['muxed/mpegts'],
            };
            const muxed: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'muxed/mpegts',
                label: 'Out',
            };
            const s302m: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/302m',
                label: 'Out',
            };
            expect(registry.validateCompatibility(muxed, sink).compatible).toBe(true);
            const rejected = registry.validateCompatibility(s302m, sink);
            expect(rejected.compatible).toBe(false);
            expect(rejected.reason).toContain('accepts only muxed/mpegts');
        });

        it('rejects audio/pcm ↔ audio/302m (PipeWire pins are not TS pins)', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/pcm',
                label: 'Out',
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'audio/302m',
                label: 'In',
            };
            expect(registry.validateCompatibility(src, sink).compatible).toBe(false);
        });

        it('rejects different stream types', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/pcm',
                label: 'Out',
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'muxed/mpegts',
                label: 'In',
            };
            const result = registry.validateCompatibility(src, sink);
            expect(result.compatible).toBe(false);
            expect(result.reason).toContain('Stream type mismatch');
        });

        it('rejects audio channel mismatch', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/pcm',
                label: 'Out',
                channelConfig: { channels: 2 },
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'audio/pcm',
                label: 'In',
                channelConfig: { channels: 6 },
            };
            const result = registry.validateCompatibility(src, sink);
            expect(result.compatible).toBe(false);
            expect(result.reason).toContain('Channel mismatch');
        });

        it('allows audio when channel counts match', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/pcm',
                label: 'Out',
                channelConfig: { channels: 2 },
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'audio/pcm',
                label: 'In',
                channelConfig: { channels: 2 },
            };
            expect(registry.validateCompatibility(src, sink).compatible).toBe(true);
        });

        it('allows audio when channel config is missing (no restriction)', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'audio/pcm',
                label: 'Out',
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'audio/pcm',
                label: 'In',
            };
            expect(registry.validateCompatibility(src, sink).compatible).toBe(true);
        });

        it('allows mpegts connections without channel check', () => {
            const src: ModulePort = {
                id: 'out',
                direction: 'output',
                streamType: 'muxed/mpegts',
                label: 'Out',
            };
            const sink: ModulePort = {
                id: 'in',
                direction: 'input',
                streamType: 'muxed/mpegts',
                label: 'In',
            };
            expect(registry.validateCompatibility(src, sink).compatible).toBe(true);
        });
    });
});
