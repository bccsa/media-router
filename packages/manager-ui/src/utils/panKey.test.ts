// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { panActivationKey } from './panKey';

function key(target: Element, init: KeyboardEventInit, type = 'keydown'): KeyboardEvent {
    const e = new KeyboardEvent(type, { bubbles: true, ...init });
    target.dispatchEvent(e);
    return e;
}

const SHIFT_SPACE = { code: 'Space', key: ' ', shiftKey: true };

afterEach(() => {
    document.body.innerHTML = '';
});

describe('panActivationKey', () => {
    it('matches Space on the canvas', () => {
        const div = document.body.appendChild(document.createElement('div'));
        expect(panActivationKey(key(div, { code: 'Space', key: ' ' }))).toBe(true);
        expect(panActivationKey(key(div, SHIFT_SPACE))).toBe(true);
    });

    it('ignores other keys', () => {
        const div = document.body.appendChild(document.createElement('div'));
        expect(panActivationKey(key(div, { code: 'KeyA', key: 'a' }))).toBe(false);
    });

    it.each(['input', 'textarea', 'select'])('ignores Shift+Space keydown in <%s>', (tag) => {
        const el = document.body.appendChild(document.createElement(tag));
        expect(panActivationKey(key(el, SHIFT_SPACE))).toBe(false);
    });

    it('ignores Space inside contenteditable', () => {
        const host = document.body.appendChild(document.createElement('div'));
        host.setAttribute('contenteditable', 'true');
        const span = host.appendChild(document.createElement('span'));
        expect(panActivationKey(key(span, SHIFT_SPACE))).toBe(false);
    });

    it('matches Space keyup in an input so a canvas pan releases', () => {
        const el = document.body.appendChild(document.createElement('input'));
        expect(panActivationKey(key(el, SHIFT_SPACE, 'keyup'))).toBe(true);
    });
});
