import { describe, it, expect } from 'vitest';
import type { Dashboard } from '@media-router/shared-types';
import { moduleIdOf, moduleOf, onlinePathOf, routerOf, routerRelative, routersOf, viewerName } from './paths';

describe('dashboard paths', () => {
    it('names the router, its online flag and the module', () => {
        expect(routerOf('/engines/e1/modules/m1/settings/volume')).toBe('e1');
        expect(routerOf('/engines/e1')).toBe('e1');
        expect(routerOf('/enginesx/e1')).toBeUndefined();
        expect(routerOf('/modules/m1')).toBeUndefined();
        expect(onlinePathOf('/engines/e1/system/cpu')).toBe('/engines/e1/info/online');
        expect(onlinePathOf('/system/cpu')).toBeUndefined();
        expect(moduleOf('/engines/e1/modules/m1/settings/volume')).toBe('/engines/e1/modules/m1');
        expect(moduleOf('/modules/m1')).toBe('/modules/m1');
        expect(moduleOf('/info/running')).toBeUndefined();
        expect(moduleIdOf('/engines/e1/modules/m1/vu')).toBe('m1');
    });

    it("lists every router a dashboard uses: values, trends and script steps", () => {
        const d = {
            name: 'd',
            widgets: [
                { id: 'a', type: 'trend', x: 0, y: 0, w: 1, h: 1, binds: ['/engines/a/system/cpu', '/engines/b/system/cpu'] },
                { id: 'b', type: 'button', x: 0, y: 0, w: 1, h: 1, script: { steps: [{ do: 'call', path: '/engines/c/modules/m1', method: 'restart' }] } },
                { id: 'c', type: 'fader', x: 0, y: 0, w: 1, h: 1, bind: '/engines/a/modules/m2/settings/volume' },
            ],
        } as unknown as Dashboard;
        expect(routersOf(d)).toEqual(['a', 'b', 'c']);
    });

    it('router-relative paths and the dashboard a viewer URL names', () => {
        expect(routerRelative('/engines/e1/system/cpu')).toBe('/system/cpu');
        expect(routerRelative('/engines/e1')).toBe('/');
        expect(routerRelative('/modules/m1')).toBe('/modules/m1');
        expect(viewerName('/d/Studio%20A/')).toBe('Studio A');
        expect(viewerName('/d/')).toBeNull();
        expect(viewerName('/other')).toBeNull();
    });
});

