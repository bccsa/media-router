import { describe, it, expect, beforeEach } from 'vitest';
import { encrypt, decrypt, clearKeyCache } from './encryption.js';

describe('encryption', () => {
    beforeEach(() => {
        clearKeyCache();
    });

    it('encrypts and decrypts a message', () => {
        const plaintext = 'Hello, Media Router!';
        const password = 'test-password-123';

        const { iv, data } = encrypt(plaintext, password);
        expect(iv).toHaveLength(32); // 16 bytes hex
        expect(data).not.toBe(plaintext);

        const result = decrypt(data, iv, password);
        expect(result).toBe(plaintext);
    });

    it('returns null for wrong password', () => {
        const { iv, data } = encrypt('secret', 'correct-password');
        const result = decrypt(data, iv, 'wrong-password');
        expect(result).toBeNull();
    });

    it('returns null for corrupted data', () => {
        const { iv } = encrypt('secret', 'password');
        const result = decrypt('corrupted-hex-data', iv, 'password');
        expect(result).toBeNull();
    });

    it('handles JSON payloads', () => {
        const payload = JSON.stringify({ topic: 'state', message: { running: true } });
        const password = 'engine-key';

        const { iv, data } = encrypt(payload, password);
        const result = decrypt(data, iv, password);
        expect(JSON.parse(result!)).toEqual({ topic: 'state', message: { running: true } });
    });

    it('produces different IVs for same plaintext', () => {
        const { iv: iv1 } = encrypt('same', 'pass');
        const { iv: iv2 } = encrypt('same', 'pass');
        expect(iv1).not.toBe(iv2);
    });

    it('handles empty string', () => {
        const { iv, data } = encrypt('', 'pass');
        const result = decrypt(data, iv, 'pass');
        expect(result).toBe('');
    });

    it('handles large payloads', () => {
        const large = 'x'.repeat(100000);
        const { iv, data } = encrypt(large, 'pass');
        const result = decrypt(data, iv, 'pass');
        expect(result).toBe(large);
    });
});
