import { execFileSync } from 'child_process';
import { createLogger, formatError } from '@media-router/shared-types';

const log = createLogger('PwLinkOps');

/**
 * Create a direct PipeWire port-to-port link using `pw-link`.
 * Returns the link ID for later removal.
 * Uses execFileSync with arg arrays — safe from shell injection.
 */
export function pwLink(outputPort: string, inputPort: string): number {
    try {
        execFileSync('pw-link', [outputPort, inputPort], { timeout: 5000 });
    } catch (err: unknown) {
        throw new Error(`pw-link failed: ${outputPort} → ${inputPort}: ${formatError(err)}`);
    }

    // Get the link ID so we can remove it later
    try {
        const output = execFileSync('pw-link', ['-I', '-o', outputPort], { timeout: 5000 }).toString();
        for (const line of output.split('\n')) {
            if (line.includes(inputPort)) {
                const match = line.match(/^\s*(\d+)/);
                if (match) return parseInt(match[1], 10);
            }
        }
    } catch { /* best effort */ }

    return 0;
}

/** Remove a PipeWire link by ID. */
export function pwUnlink(linkId: number): void {
    if (linkId <= 0) return;
    try {
        execFileSync('pw-link', ['-d', String(linkId)], { timeout: 5000 });
    } catch { /* link may already be gone */ }
}

/** Remove a PipeWire link by port names. */
export function pwUnlinkByName(outputPort: string, inputPort: string): boolean {
    try {
        execFileSync('pw-link', ['-d', outputPort, inputPort], { timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

/**
 * Remove ALL direct pw-link connections between two nodes.
 * Uses a single `pw-link -l` call to find existing links, then removes only those.
 * Efficient: O(1) list call + O(k) unlink calls where k = actual links found.
 */
export function pwUnlinkAllBetween(sourceNode: string, sinkNode: string): void {
    const baseSource = sourceNode.replace(/\.monitor$/, '');
    const baseSink = sinkNode.replace(/\.monitor$/, '');
    try {
        const output = execFileSync('pw-link', ['-l'], { timeout: 5000 }).toString();
        const lines = output.split('\n');
        let currentOutput = '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('|')) {
                // This is an output port line
                currentOutput = trimmed;
            } else if (trimmed.startsWith('|->') || trimmed.startsWith('|<-')) {
                // This is a linked input port
                const linkedPort = trimmed.replace(/^\|[<>]->\s*/, '').trim();
                // Check if this is a link between our source and sink nodes
                if (currentOutput.startsWith(baseSource + ':') && linkedPort.startsWith(baseSink + ':')) {
                    pwUnlinkByName(currentOutput, linkedPort);
                }
            }
        }
    } catch { /* ignore */ }
}

/**
 * List PipeWire ports for a node, ordered by channel index.
 * Uses execFileSync with argument arrays (no shell interpolation).
 */
export function listPorts(node: string, direction: 'input' | 'output'): string[] {
    const flag = direction === 'output' ? '-o' : '-i';
    try {
        const output = execFileSync('pw-link', [flag], { timeout: 5000 }).toString();
        const baseNode = node.replace(/\.monitor$/, '');
        const ports = output.split('\n')
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
    } catch {
        return [];
    }
}

/**
 * List all active PipeWire links.
 */
export function getLinks(): Array<{ output: string; input: string }> {
    try {
        const output = execFileSync('pw-link', ['-l'], {
            encoding: 'utf-8',
            timeout: 5000,
            env: { ...process.env, DISPLAY: '' },
        });
        const links: Array<{ output: string; input: string }> = [];
        let currentOutput = '';

        for (const line of output.split('\n')) {
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
    } catch {
        return [];
    }
}
