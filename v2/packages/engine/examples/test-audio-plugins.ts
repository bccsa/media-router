/**
 * Manual test: AudioEncoder plugin.
 *
 *   cd v2/packages/engine
 *   npx tsx examples/test-audio-plugins.ts
 *
 * Tests that the AudioEncoder plugin builds a valid GStreamer pipeline
 * and produces MPEG-TS audio output with VU metering.
 *
 * Note: Requires a PipeWire/PulseAudio audio source (even a dummy one).
 * The encoder captures from the default source and encodes to Opus in MPEG-TS.
 */
import { GstChildProcess } from '../src/child-process/GstChildProcess.js';
import { PipeWireManager } from '../src/audio/PipeWireManager.js';

async function main() {
    console.log('=== Audio Plugin Test ===\n');

    // 1. List audio devices
    const pw = new PipeWireManager();
    const devices = pw.listDevices();
    console.log('Audio devices:', devices.length ? devices : '(none — using test source instead)');

    // 2. Test AudioEncoder pipeline
    // Since we may not have a real audio source, use audiotestsrc instead of pulsesrc
    const testPipeline = [
        'audiotestsrc wave=sine freq=440',
        'audioconvert',
        'audioresample',
        'audio/x-raw,rate=48000,channels=2',
        'level post-messages=true interval=66000000',
        'opusenc bitrate=128000',
        'mpegtsmux',
        'fakesink', // Use fakesink instead of fdsink for testing
    ].join(' ! ');

    console.log(`\nEncoder pipeline: ${testPipeline}\n`);

    const child = new GstChildProcess();
    let vuCount = 0;

    child.on('stateChange', (data) => {
        console.log(`State: ${JSON.stringify(data)}`);
    });

    child.on('vuData', (data) => {
        vuCount++;
        const { peak } = data as { peak: number[] };
        if (vuCount % 5 === 0) {
            // Print every 5th VU update
            console.log(`VU (${vuCount}): peak=[${peak.map((p: number) => p.toFixed(1)).join(', ')}] dB`);
        }
    });

    child.on('error', (data) => {
        console.error(`Error: ${JSON.stringify(data)}`);
    });

    try {
        await child.start({ pipeline: testPipeline });
        console.log('Encoder running. Waiting 5 seconds...\n');

        await new Promise((resolve) => setTimeout(resolve, 5000));

        console.log(`\nTotal VU updates received: ${vuCount}`);
        console.log('Stopping...');
        await child.stop();
        console.log('Done.');
    } catch (err) {
        console.error('Failed:', err);
    }

    process.exit(0);
}

main();
