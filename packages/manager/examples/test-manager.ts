/**
 * Manual test: start the Manager and test with curl.
 *
 *   cd packages/manager
 *   npx tsx examples/test-manager.ts
 *
 * Then in another terminal:
 *   curl http://localhost:8080/health
 *   curl http://localhost:8080/api/v1/engines
 *   curl -X POST http://localhost:8080/api/v1/engines -H 'Content-Type: application/json' -d '{"engineId":"sdr","displayName":"SDR Engine","password":"secret"}'
 *   curl http://localhost:8080/api/v1/engines
 *   curl http://localhost:8080/api/v1/plugins
 *   curl http://localhost:8080/api/v1/engines/sdr/profiles
 */
import { Manager } from '../src/Manager.js';

const manager = new Manager({
    httpPort: 8080,
    dgramPort: 3000,
});

manager.start().then(() => {
    console.log('\n=== Manager running ===');
    console.log('HTTP:   http://localhost:8080');
    console.log('dgram:  UDP port 3000');
    console.log('\nTry:');
    console.log('  curl http://localhost:8080/health');
    console.log('  curl http://localhost:8080/api/v1/engines');
    console.log('  curl http://localhost:8080/api/v1/plugins');
    console.log('\nPress Ctrl+C to stop.\n');
});

process.on('SIGINT', async () => {
    await manager.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await manager.stop();
    process.exit(0);
});
