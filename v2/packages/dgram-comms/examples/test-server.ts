/**
 * Manual test: run this in Terminal 1, then run test-client.ts in Terminal 2.
 *
 *   npx tsx examples/test-server.ts
 */
import { Server } from '../src/Server.js';

const server = new Server({
    port: 3000,
    encryptionKeys: {
        'engine-1': 'my-secret-password',
    },
});

server.on('connection', (socket, clientId) => {
    console.log(`\n✅ Engine connected: ${clientId} (socket: ${socket.socketID})`);

    // Listen for messages from the engine
    socket.on('state', (msg: unknown) => {
        console.log(`📨 Received "state" from ${clientId}:`, JSON.stringify(msg));
    });

    socket.on('hello', (msg: unknown) => {
        console.log(`📨 Received "hello" from ${clientId}:`, msg);
        // Reply back
        socket.send('reply', { text: 'Hello from manager!', time: new Date().toISOString() });
        console.log(`📤 Sent "reply" back to ${clientId}`);
    });

    socket.on('disconnected', () => {
        console.log(`❌ Engine disconnected: ${clientId}`);
    });

    // Send a config push to the engine
    setTimeout(() => {
        console.log(`\n📤 Sending config to ${clientId}...`);
        server.sendTo(clientId, 'config', {
            modules: { 'srt-input-1': { pluginId: 'srt-input', displayName: 'SRT Input' } },
        }, { guaranteeDelivery: true });
    }, 1000);
});

server.on('disconnection', (clientId) => {
    console.log(`❌ Engine disconnected: ${clientId}`);
});

server.start().then(() => {
    console.log('🟢 dgram-comms Server listening on port 3000');
    console.log('   Waiting for engine connections...');
    console.log('   Run test-client.ts in another terminal.\n');
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    await server.stop();
    process.exit(0);
});
