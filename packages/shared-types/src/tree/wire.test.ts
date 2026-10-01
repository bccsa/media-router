import { describe, it, expect } from 'vitest';
import { protocolMismatch, requiredProtocol, TREE_PROTOCOL } from './wire.js';

describe('tree protocol version', () => {
    it('a refusal names the version the server wants, and a client reads it back', () => {
        expect(requiredProtocol(protocolMismatch(undefined))).toBe(TREE_PROTOCOL);
        expect(requiredProtocol('something else')).toBeNull();
    });
});
