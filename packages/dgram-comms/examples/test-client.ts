/**
 * Manual test: run test-server.ts first in Terminal 1, then run this in Terminal 2.
 *
 *   npx tsx examples/test-client.ts
 */
import { Client } from '../src/Client.js';

const client = new Client({
    clientId: 'engine-1',
    paths: [
        { host: '127.0.0.1', port: 3000 },
        // Uncomment for multi-path test (second path to same server):
        // { host: '127.0.0.1', port: 3000 },
    ],
    encryptionKey: 'my-secret-password',
    connectionTimeout: 5000,
});

client.on('connected', () => {
    console.log('✅ Connected to manager!\n');

    // Send a hello message
    console.log('📤 Sending "hello" to manager...');
    client.send('hello', { text: 'Hello from engine!', engineId: 'engine-1' });

    // Send state updates every 3 seconds
    let count = 0;
    const interval = setInterval(() => {
        count++;
        const state = {
            running: true,
            health: 'ok',
            modules: count,
            cpu: Math.round(Math.random() * 100),
            memory: Math.round(Math.random() * 512),
            timestamp: new Date().toISOString(),
        };
        console.log(`📤 Sending state update #${count}:`, JSON.stringify(state));
        client.send('state', state);

        if (count >= 5) {
            clearInterval(interval);
            console.log('\n✅ Done sending 5 state updates. Press Ctrl+C to exit.');
        }
    }, 3000);
});

client.on('disconnected', () => {
    console.log('❌ Disconnected from manager');
});

client.on('pathDown', (index: number) => {
    console.log(`⚠️  Path ${index} down`);
});

client.on('pathUp', (index: number) => {
    console.log(`✅ Path ${index} up`);
});

// Listen for messages from manager
client.on('data', (topic: string, message: unknown) => {
    console.log(`📨 Received "${topic}" from manager:`, JSON.stringify(message));
});

console.log('🔌 Connecting to manager at 127.0.0.1:3000...');

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down client...');
    client.destroy();
    process.exit(0);
});
