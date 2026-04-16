import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger, formatError } from '@media-router/shared-types';

const log = createLogger('PwLinkOps');
const execFileAsync = promisify(execFile);

/**
 * Verify pw-link is installed. Throws if missing — pipewire-tools is a required package.
 * Call once at engine startup before any audio routing.
 */
export async function requirePwLink(): Promise<void> {
    try {
        await execFileAsync('pw-link', ['--version'], { timeout: 3000 });
    } catch {
        throw new Error(
            'pw-link not found. Install pipewire-tools: this is a required package for audio routing. '
            + 'Yocto: IMAGE_INSTALL:append = " pipewire-tools" | Debian: apt install pipewire',
        );
    }
}

/**
 * Create a direct PipeWire port-to-port link using `pw-link`.
 * Returns the link ID for later removal.
 */
export async function pwLink(outputPort: string, inputPort: string): Promise<number> {
    try {
        await execFileAsync('pw-link', [outputPort, inputPort], { timeout: 5000 });
    } catch (err: unknown) {
        throw new Error(`pw-link failed: ${outputPort} → ${inputPort}: ${formatError(err)}`);
    }

    // Get the link ID so we can remove it later
    try {
        const { stdout } = await execFileAsync('pw-link', ['-I', '-o', outputPort], { timeout: 5000 });
        for (const line of stdout.split('\n')) {
            if (line.includes(inputPort)) {
                const match = line.match(/^\s*(\d+)/);
                if (match) return parseInt(match[1], 10);
            }
        }
    } catch (err) {
        log.debug({ err, outputPort, inputPort }, 'Could not retrieve link ID after pw-link');
    }

    return 0;
}

/** Remove a PipeWire link by ID. */
export async function pwUnlink(linkId: number): Promise<void> {
    if (linkId <= 0) return;
    try {
        await execFileAsync('pw-link', ['-d', String(linkId)], { timeout: 5000 });
    } catch (err) { log.debug({ err, linkId }, 'pw-link unlink failed (link may already be gone)'); }
}

/** Remove a PipeWire link by port names. */
export async function pwUnlinkByName(outputPort: string, inputPort: string): Promise<boolean> {
    try {
        await execFileAsync('pw-link', ['-d', outputPort, inputPort], { timeout: 5000 });
        return true;
    } catch (err) {
        log.debug({ err, outputPort, inputPort }, 'pw-link unlink by name failed');
        return false;
    }
}

/**
 * Remove ALL direct pw-link connections between two nodes.
 * Uses a single `pw-link -l` call to find existing links, then removes only those.
 */
export async function pwUnlinkAllBetween(sourceNode: string, sinkNode: string): Promise<void> {
    const baseSource = sourceNode.replace(/\.monitor$/, '');
    const baseSink = sinkNode.replace(/\.monitor$/, '');
    try {
        const { stdout } = await execFileAsync('pw-link', ['-l'], { timeout: 5000 });
        const lines = stdout.split('\n');
        let currentOutput = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('|')) {
                currentOutput = trimmed;
            } else if (trimmed.startsWith('|->') || trimmed.startsWith('|<-')) {
                const linkedPort = trimmed.replace(/^\|[<>]->\s*/, '').trim();
                if (currentOutput.startsWith(baseSource + ':') && linkedPort.startsWith(baseSink + ':')) {
                    await pwUnlinkByName(currentOutput, linkedPort);
                }
            }
        }
    } catch (err) { log.debug({ err, sourceNode, sinkNode }, 'pw-link sweep failed'); }
}

/**
 * List PipeWire ports for a node, ordered by channel index.
 */
export async function listPorts(node: string, direction: 'input' | 'output'): Promise<string[]> {
    const flag = direction === 'output' ? '-o' : '-i';
    try {
        const { stdout } = await execFileAsync('pw-link', [flag], { timeout: 5000 });
        const baseNode = node.replace(/\.monitor$/, '');
        const ports = stdout.split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith(baseNode + ':') || l.startsWith(node + ':'));

        ports.sort((a, b) => {
            const chA = a.split(':')[1] ?? '';
            const chB = b.split(':')[1] ?? '';
            const order = (ch: string) => {
                if (ch.includes('MONO')) return 0;
                if (ch.includes('FL')) return 0;
                if (ch.includes('FR')) return 1;
                const num = parseInt(ch.replace(/\D/g, ''), 10);
                return isNaN(num) ? 99 : num;
            };
            return order(chA) - order(chB);
        });

        return ports;
    } catch (err) {
        log.warn({ err, node, direction }, 'pw-link port listing failed — returning empty');
        return [];
    }
}

/**
 * List all active PipeWire links.
 */
export async function getLinks(): Promise<Array<{ output: string; input: string }>> {
    try {
        const { stdout } = await execFileAsync('pw-link', ['-l'], {
            timeout: 5000,
            env: { ...process.env, DISPLAY: '' },
        });
        const links: Array<{ output: string; input: string }> = [];
        let currentOutput = '';

        for (const line of stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('|->') || trimmed.startsWith('|<-')) {
                const linkedPort = trimmed.replace(/^\|[-<>]+\s*/, '');
                if (currentOutput && linkedPort) {
                    links.push({ output: currentOutput, input: linkedPort });
                }
            } else if (!trimmed.startsWith('|')) {
                currentOutput = trimmed;
            }
        }

        return links;
    } catch (err) {
        log.warn({ err }, 'pw-link listing failed — returning empty');
        return [];
    }
}
