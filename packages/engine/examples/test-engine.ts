/**
 * Manual test: start the engine and test the Local API.
 *
 *   cd packages/engine
 *   npx tsx examples/test-engine.ts
 *
 * Then in another terminal:
 *   curl http://localhost:3001/api/v1/health
 *   curl http://localhost:3001/api/v1/system
 *   curl http://localhost:3001/api/v1/engine/status
 *   curl http://localhost:3001/api/v1/profiles
 *   curl -X POST http://localhost:3001/api/v1/profiles -H 'Content-Type: application/json' -d '{"name":"test","managerHost":"10.0.0.1","managerPort":3000,"password":"secret"}'
 *   curl http://localhost:3001/api/v1/profiles
 *   curl -X POST http://localhost:3001/api/v1/profiles/test/activate
 *   curl http://localhost:3001/api/v1/engine/status
 */
import { Engine } from '../src/Engine.js';

const engine = new Engine({
    apiPort: 3001,
    lcpPort: 8081,
});

engine.start().then(() => {
    console.log('\n=== Engine running ===');
    console.log('Local API:  http://localhost:3001/api/v1/health');
    console.log('LCP:        Socket.IO on port 8081');
    console.log('\nPress Ctrl+C to stop.\n');
});

async function gracefulShutdown() {
    await engine.stop();
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Emergency cleanup: kill all descendant processes when this process exits
// This catches tsx --watch restarts where graceful shutdown may not complete
process.on('exit', () => {
    try {
        // Kill entire process group (includes gst-runner + python grandchildren)
        process.kill(-process.pid, 'SIGTERM');
    } catch { /* best effort — may fail if not process group leader */ }
    try {
        // Fallback: kill known child PIDs recursively
        const { execFileSync } = require('child_process');
        execFileSync('pkill', ['-TERM', '-P', String(process.pid)], { timeout: 1000 });
    } catch { /* best effort */ }
});
