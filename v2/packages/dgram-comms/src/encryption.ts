import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/** Cache: password → 32-byte key Buffer. Avoids re-hashing on every message. */
const keyCache = new Map<string, Buffer>();

/** Derive a 32-byte AES key from a password via SHA-256. Cached. */
function deriveKey(password: string): Buffer {
    let key = keyCache.get(password);
    if (!key) {
        key = crypto.createHash('sha256').update(password).digest();
        keyCache.set(password, key);
    }
    return key;
}

/**
 * Encrypt a plaintext string with AES-256-CBC.
 * Returns the IV (hex) and encrypted data (hex).
 */
export function encrypt(plaintext: string, password: string): { iv: string; data: string } {
    const key = deriveKey(password);
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), data: encrypted };
}

/**
 * Decrypt a ciphertext (hex) with AES-256-CBC.
 * Returns the plaintext string, or null if decryption fails (wrong key, corrupted data).
 */
export function decrypt(ciphertext: string, iv: string, password: string): string | null {
    try {
        const key = deriveKey(password);
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        return null;
    }
}

/** Clear the key cache (useful for tests). */
export function clearKeyCache(): void {
    keyCache.clear();
}
