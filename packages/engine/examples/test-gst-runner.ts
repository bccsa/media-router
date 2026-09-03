/**
 * Manual test: spawn a GStreamer pipeline via GstChildProcess.
 *
 *   cd packages/engine
 *   npx tsx examples/test-gst-runner.ts
 *
 * You should see:
 *   - Pipeline state changes (playing)
 *   - VU meter data printing every ~66ms
 *   - Pipeline stops after 5 seconds
 */
import { GstChildProcess } from '../src/child-process/GstChildProcess.js';

async function main() {
    console.log('=== GstChildProcess Test ===\n');

    // Hosts the runner in this process (ADR-0012) and spawns the python
    // pipeline runner from src/child-process — no build step needed under tsx.
    const child = new GstChildProcess();

    child.on('stateChange', (data) => {
        console.log(`State: ${JSON.stringify(data)}`);
    });

    child.on('vuData', (data) => {
        const { peak } = data as { peak: number[] };
        const bars = peak.map((p: number) => {
            const level = Math.max(0, Math.min(40, 40 + p));
            return '█'.repeat(Math.round(level)) + '░'.repeat(40 - Math.round(level));
        });
        console.log(`VU: ${bars.join(' | ')} [${peak.map((p: number) => p.toFixed(1)).join(', ')} dB]`);
    });

    child.on('error', (data) => {
        console.error(`Error: ${JSON.stringify(data)}`);
    });

    child.on('exit', (code) => {
        console.log(`Child exited with code: ${code}`);
    });

    // Test pipeline: generate a test tone and measure levels
    const pipeline = 'audiotestsrc wave=sine freq=440 ! audio/x-raw,channels=2 ! level post-messages=true interval=66000000 ! fakesink';

    console.log(`Starting pipeline: ${pipeline}\n`);

    try {
        await child.start({ pipeline });
        console.log('Pipeline started. Waiting 5 seconds...\n');

        await new Promise((resolve) => setTimeout(resolve, 5000));

        console.log('\nStopping pipeline...');
        await child.stop();
        console.log('Done.');
    } catch (err) {
        console.error('Failed:', err);
    }

    process.exit(0);
}

main();
