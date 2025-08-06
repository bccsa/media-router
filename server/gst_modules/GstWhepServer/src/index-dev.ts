// WHEP Server with GStreamer WebRTC Broadcasting
import { WHEPGStreamerServer } from './whep-server-gstreamer';

async function main(): Promise<void> {
    console.log('🎵 GStreamer WHEP Server');
    console.log('=======================');
    console.log('');

    try {
        const server = new WHEPGStreamerServer({
            pulseDevice: process.env.PULSE_DEVICE || 'default',
        });

        // Graceful shutdown handling
        process.on('SIGINT', () => {
            console.log('🛑 Received SIGINT, shutting down gracefully...');
            server.stop();
        });

        process.on('SIGTERM', () => {
            console.log('🛑 Received SIGTERM, shutting down gracefully...');
            server.stop();
        });

        // Start the server
        const port = parseInt(process.env.PORT || '9090');
        server.start(port);
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('❌ Unhandled error:', error);
    process.exit(1);
});

// export * from './whep-server-gstreamer';
