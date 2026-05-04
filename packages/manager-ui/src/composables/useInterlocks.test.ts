import { describe, it, expect } from 'vitest';
import {
    isInterlockEligible,
    getInterlockForModule,
    getHotMember,
    willMuteOnUnmute,
    newInterlockId,
    readableTextOn,
} from './useInterlocks';
import type { EngineState, ModuleState, InterlockState } from '@/stores/engines';

function makeMod(id: string, audioEnabled: boolean | undefined, interlock = true): ModuleState {
    return {
        instanceId: id,
        pluginId: 'audio-encoder',
        displayName: id.toUpperCase(),
        running: false,
        enabled: true,
        health: 'stopped',
        pendingRestart: false,
        settings: audioEnabled === undefined ? {} : { audioEnabled },
        interlock,
    } as ModuleState;
}

function makeEngine(mods: ModuleState[], interlocks: InterlockState[]): EngineState {
    return {
        engineId: 'eng-1',
        name: 'Eng',
        online: true,
        running: false,
        activeProfile: 'default',
        modules: Object.fromEntries(mods.map((m) => [m.instanceId, m])),
        connections: [],
        interlocks,
    };
}

describe('useInterlocks', () => {
    it('isInterlockEligible reads the manifest flag', () => {
        expect(isInterlockEligible(makeMod('a', true, true))).toBe(true);
        expect(isInterlockEligible(makeMod('a', true, false))).toBe(false);
        expect(isInterlockEligible(undefined)).toBe(false);
    });

    it('getInterlockForModule returns the owning group or undefined', () => {
        const engine = makeEngine(
            [makeMod('a', true), makeMod('b', false), makeMod('solo', false)],
            [{ id: 'g1', name: 'G1', members: ['a', 'b'] }],
        );
        expect(getInterlockForModule(engine, 'a')?.id).toBe('g1');
        expect(getInterlockForModule(engine, 'solo')).toBeUndefined();
    });

    it('getHotMember returns the unmuted member (undefined audioEnabled counts as hot)', () => {
        const engine = makeEngine(
            [makeMod('a', undefined), makeMod('b', false)],
            [{ id: 'g1', name: 'G1', members: ['a', 'b'] }],
        );
        expect(getHotMember(engine, engine.interlocks[0])?.instanceId).toBe('a');
    });

    it('getHotMember returns undefined when all members are muted', () => {
        const engine = makeEngine(
            [makeMod('a', false), makeMod('b', false)],
            [{ id: 'g1', name: 'G1', members: ['a', 'b'] }],
        );
        expect(getHotMember(engine, engine.interlocks[0])).toBeUndefined();
    });

    it('willMuteOnUnmute lists all currently-hot siblings', () => {
        const engine = makeEngine(
            [makeMod('a', false), makeMod('b', true), makeMod('c', true), makeMod('d', false)],
            [{ id: 'g1', name: 'G1', members: ['a', 'b', 'c', 'd'] }],
        );
        const siblings = willMuteOnUnmute(engine, 'a').map((m) => m.instanceId);
        expect(siblings).toEqual(['b', 'c']);
    });

    it('willMuteOnUnmute returns [] for modules not in a group', () => {
        const engine = makeEngine([makeMod('solo', false)], []);
        expect(willMuteOnUnmute(engine, 'solo')).toEqual([]);
    });

    it('newInterlockId generates unique ids with the ilk- prefix', () => {
        const a = newInterlockId();
        const b = newInterlockId();
        expect(a).toMatch(/^ilk-/);
        expect(a).not.toBe(b);
    });

    describe('readableTextOn', () => {
        it('returns dark text on light backgrounds', () => {
            expect(readableTextOn('#ffffff')).toBe('#0f1117');
            expect(readableTextOn('#ffff00')).toBe('#0f1117'); // yellow
            expect(readableTextOn('#fde68a')).toBe('#0f1117'); // pale amber
        });

        it('returns light text on dark backgrounds', () => {
            expect(readableTextOn('#0f1117')).toBe('#ffffff');
            expect(readableTextOn('#a855f7')).toBe('#ffffff'); // default purple
            expect(readableTextOn('#1e40af')).toBe('#ffffff'); // dark blue
        });

        it('handles 3-digit hex and missing leading hash', () => {
            expect(readableTextOn('fff')).toBe('#0f1117');
            expect(readableTextOn('#000')).toBe('#ffffff');
        });

        it('falls back to white for invalid input', () => {
            expect(readableTextOn(undefined)).toBe('#ffffff');
            expect(readableTextOn('')).toBe('#ffffff');
            expect(readableTextOn('not-a-color')).toBe('#ffffff');
        });
    });
});
