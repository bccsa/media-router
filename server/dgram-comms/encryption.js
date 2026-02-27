const crypto = require("crypto");

// Encryption/Decryption utilities
const ENCRYPTION_ALGORITHM = "aes-256-cbc";

function encrypt(text, key) {
    return new Promise((resolve) => {
        hashValue(key).then((hash) => {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv(
                ENCRYPTION_ALGORITHM,
                hash, // Pass the raw 32-byte Buffer directly
                iv
            );
            let encrypted = cipher.update(text, "utf8", "hex");
            encrypted += cipher.final("hex");
            resolve({
                iv: iv.toString("hex"),
                encryptedData: encrypted,
            });
        });
    });
}

function decrypt(encryptedData, iv, key) {
    return new Promise((resolve) => {
        hashValue(key).then((hash) => {
            try {
                const decipher = crypto.createDecipheriv(
                    ENCRYPTION_ALGORITHM,
                    hash, // Pass the raw 32-byte Buffer directly
                    Buffer.from(iv, "hex")
                );
                let decrypted = decipher.update(encryptedData, "hex", "utf8");
                decrypted += decipher.final("utf8");
                resolve(decrypted);
            } catch (err) {
                resolve(null);
            }
        });
    });
}

// Cache for hashed keys
const hashCache = new Map();

// Return a 32-byte Buffer directly from SHA-256 hash (cached)
async function hashValue(val) {
    if (hashCache.has(val)) return hashCache.get(val);
    const hash = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder("utf-8").encode(val))
    );
    hashCache.set(val, hash);
    return hash;
}

module.exports = {
    encrypt,
    decrypt,
};
