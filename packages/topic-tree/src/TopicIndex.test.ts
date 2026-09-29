import { describe, it, expect } from 'vitest';
import { parsePattern as p, splitPath as s } from '@media-router/shared-types';
import { TopicIndex } from './TopicIndex.js';

describe('TopicIndex', () => {
    it('matches patterns that cover the path', () => {
        const idx = new TopicIndex();
        idx.add('a', p('/engines/e1'));
        idx.add('b', p('/engines/e2'));
        const hits = idx.match(s('/engines/e1/modules/m/vu'));
        expect([...hits.keys()]).toEqual(['a']);
        expect(hits.get('a')).toEqual([['engines', 'e1']]);
    });

    it('matches deeper patterns for an ancestor write', () => {
        const idx = new TopicIndex();
        idx.add('a', p('/engines/+/modules/+/health'));
        const hits = idx.match(s('/engines/e1/modules'));
        expect(hits.get('a')).toEqual([['engines', '+', 'modules', '+', 'health']]);
        expect(idx.match(s('/engines/e1/info')).size).toBe(0);
    });

    it('follows both literal and wildcard branches', () => {
        const idx = new TopicIndex();
        idx.add('a', p('/engines/+/info'));
        idx.add('b', p('/engines/e1/info/online'));
        const hits = idx.match(s('/engines/e1/info/online'));
        expect([...hits.keys()].sort()).toEqual(['a', 'b']);
    });

    it('removes patterns and whole subscribers', () => {
        const idx = new TopicIndex();
        idx.add('a', p('/engines/e1'));
        expect(idx.add('a', p('/engines/e1'))).toBe(false);
        idx.add('a', p('/groups'));
        expect(idx.remove('a', p('/engines/e1'))).toBe(true);
        expect(idx.match(s('/engines/e1')).size).toBe(0);
        idx.removeSubscriber('a');
        expect(idx.match(s('/groups')).size).toBe(0);
        expect(idx.patternsOf('a')).toEqual([]);
    });

    it('a root pattern covers everything', () => {
        const idx = new TopicIndex();
        idx.add('a', p('/'));
        expect(idx.match(s('/anything/at/all')).has('a')).toBe(true);
    });
});
