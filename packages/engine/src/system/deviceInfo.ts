import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/** Get the primary non-loopback IPv4 address. */
export function getPrimaryIp(): string {
    const ips = getAllIps();
    return ips.length > 0 ? ips[0] : '127.0.0.1';
}

/** Get all non-loopback IPv4 addresses. */
export function getAllIps(): string[] {
    const interfaces = os.networkInterfaces();
    const ips: string[] = [];
    for (const addrs of Object.values(interfaces)) {
        if (!addrs) continue;
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
        }
    }
    return ips;
}

/**
 * Search for build-number.txt in the given directory and up to 3 parent levels.
 * Returns the trimmed content, or empty string if not found.
 */
export function findBuildNumber(startDir = process.cwd()): string {
    let dir = startDir;
    for (let i = 0; i < 4; i++) {
        try {
            return fs.readFileSync(path.join(dir, 'build-number.txt'), 'utf-8').trim();
        } catch { /* not found here */ }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '';
}

/** Get hostname. */
export function getHostname(): string {
    return os.hostname();
}
