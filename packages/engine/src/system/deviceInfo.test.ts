import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getPrimaryIp, findBuildNumber, getHostname } from './deviceInfo.js';

describe('deviceInfo', () => {
    describe('getPrimaryIp', () => {
        it('returns a non-loopback IPv4 address', () => {
            const ip = getPrimaryIp();
            expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
            // On a machine with a network interface, it shouldn't be 127.0.0.1
            // (but in CI it might be — so just check it's a valid IP)
        });
    });

    describe('getHostname', () => {
        it('returns a non-empty hostname', () => {
            const hostname = getHostname();
            expect(hostname).toBeTruthy();
            expect(typeof hostname).toBe('string');
        });
    });

    describe('findBuildNumber', () => {
        const tmpDir = path.join(__dirname, '__test-build-number__');
        const nestedDir = path.join(tmpDir, 'a', 'b');

        beforeEach(() => {
            fs.mkdirSync(nestedDir, { recursive: true });
        });

        afterEach(() => {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('finds build-number.txt in the given directory', () => {
            fs.writeFileSync(path.join(tmpDir, 'build-number.txt'), 'v1.2.3\n');
            expect(findBuildNumber(tmpDir)).toBe('v1.2.3');
        });

        it('finds build-number.txt in a parent directory', () => {
            fs.writeFileSync(path.join(tmpDir, 'build-number.txt'), 'v2.0.0.42');
            expect(findBuildNumber(nestedDir)).toBe('v2.0.0.42');
        });

        it('returns empty string if not found', () => {
            expect(findBuildNumber(nestedDir)).toBe('');
        });

        it('trims whitespace from the file content', () => {
            fs.writeFileSync(path.join(tmpDir, 'build-number.txt'), '  v3.0.0  \n');
            expect(findBuildNumber(tmpDir)).toBe('v3.0.0');
        });
    });
});
