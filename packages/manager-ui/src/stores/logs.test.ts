/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useLogStore, LEVEL_LABELS, LEVEL_COLORS, type LogEntry } from './logs';

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
    return { level: 30, time: '2026-01-01T00:00:00Z', name: 'test', msg: 'hello', ...overrides };
}

describe('useLogStore', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    describe('getEntries', () => {
        it('returns empty array for unknown engine', () => {
            const store = useLogStore();
            expect(store.getEntries('eng-1')).toEqual([]);
        });
    });

    describe('addEntries', () => {
        it('adds a batch of log entries', () => {
            const store = useLogStore();
            const batch = [makeEntry({ msg: 'a' }), makeEntry({ msg: 'b' })];
            store.addEntries('eng-1', batch);
            expect(store.getEntries('eng-1')).toHaveLength(2);
            expect(store.getEntries('eng-1')[0].msg).toBe('a');
        });

        it('appends to existing entries', () => {
            const store = useLogStore();
            store.addEntries('eng-1', [makeEntry({ msg: 'first' })]);
            store.addEntries('eng-1', [makeEntry({ msg: 'second' })]);
            expect(store.getEntries('eng-1')).toHaveLength(2);
            expect(store.getEntries('eng-1')[1].msg).toBe('second');
        });

        it('tracks multiple engines independently', () => {
            const store = useLogStore();
            store.addEntries('eng-1', [makeEntry({ msg: 'a' })]);
            store.addEntries('eng-2', [makeEntry({ msg: 'b' })]);
            expect(store.getEntries('eng-1')).toHaveLength(1);
            expect(store.getEntries('eng-2')).toHaveLength(1);
        });

        it('trims entries exceeding MAX_ENTRIES (2000)', () => {
            const store = useLogStore();
            // Add 1990 entries
            const initial = Array.from({ length: 1990 }, (_, i) => makeEntry({ msg: `msg-${i}` }));
            store.addEntries('eng-1', initial);
            expect(store.getEntries('eng-1')).toHaveLength(1990);

            // Add 20 more — should trim to 2000
            const extra = Array.from({ length: 20 }, (_, i) => makeEntry({ msg: `extra-${i}` }));
            store.addEntries('eng-1', extra);
            expect(store.getEntries('eng-1')).toHaveLength(2000);

            // Oldest entries should be trimmed — first entry should be msg-10
            expect(store.getEntries('eng-1')[0].msg).toBe('msg-10');
        });
    });

    describe('setHistory', () => {
        it('replaces all entries for an engine', () => {
            const store = useLogStore();
            store.addEntries('eng-1', [makeEntry({ msg: 'old' })]);
            store.setHistory('eng-1', [makeEntry({ msg: 'new-1' }), makeEntry({ msg: 'new-2' })]);
            expect(store.getEntries('eng-1')).toHaveLength(2);
            expect(store.getEntries('eng-1')[0].msg).toBe('new-1');
        });

        it('trims history to MAX_ENTRIES keeping the tail', () => {
            const store = useLogStore();
            const history = Array.from({ length: 2500 }, (_, i) => makeEntry({ msg: `h-${i}` }));
            store.setHistory('eng-1', history);
            expect(store.getEntries('eng-1')).toHaveLength(2000);
            // Should keep the last 2000 entries
            expect(store.getEntries('eng-1')[0].msg).toBe('h-500');
        });
    });

    describe('clear', () => {
        it('clears entries for an engine', () => {
            const store = useLogStore();
            store.addEntries('eng-1', [makeEntry(), makeEntry()]);
            store.clear('eng-1');
            expect(store.getEntries('eng-1')).toEqual([]);
        });

        it('does not affect other engines', () => {
            const store = useLogStore();
            store.addEntries('eng-1', [makeEntry({ msg: 'a' })]);
            store.addEntries('eng-2', [makeEntry({ msg: 'b' })]);
            store.clear('eng-1');
            expect(store.getEntries('eng-1')).toEqual([]);
            expect(store.getEntries('eng-2')).toHaveLength(1);
        });

        it('is safe on unknown engine', () => {
            const store = useLogStore();
            expect(() => store.clear('nonexistent')).not.toThrow();
        });
    });
});

describe('LEVEL_LABELS', () => {
    it('maps pino level numbers to labels', () => {
        expect(LEVEL_LABELS[10]).toBe('trace');
        expect(LEVEL_LABELS[20]).toBe('debug');
        expect(LEVEL_LABELS[30]).toBe('info');
        expect(LEVEL_LABELS[40]).toBe('warn');
        expect(LEVEL_LABELS[50]).toBe('error');
        expect(LEVEL_LABELS[60]).toBe('fatal');
    });
});

describe('LEVEL_COLORS', () => {
    it('has a color for each level', () => {
        for (const level of [10, 20, 30, 40, 50, 60]) {
            expect(LEVEL_COLORS[level]).toBeDefined();
        }
    });
});
