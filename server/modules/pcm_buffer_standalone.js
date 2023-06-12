const { Transform } = require("stream");

var args = {};  // object with key value pairs of passed arguments
var channels = 2;
var bitdepth = 16;
var buffersize = 512;   // buffer size in bytes

/**
 * Transform stream that implements a configurable PCM buffer
 */
class pcmBuffer extends Transform {
    constructor(channels = 1, bitdepth = 16, buffersize = 512) {
        super();
        this._buffer = Buffer.alloc(0);
        this.channels = channels;       // pcm stream channel count
        this.bitdepth = bitdepth;       // pcm stream bit depth
        this.buffersize = buffersize;   // buffer size in bytes
        this._sampleSize = this.channels * this.bitdepth / 8
        this._bufferMax = Math.floor(this.buffersize / this._sampleSize) * this._sampleSize; // buffer size adjusted to sample size
    }

    _read() {
        // Prevent sending an empty buffer and stopping the stream
        if (this._buffer.length > 0) {
            this.push(this._buffer);
            this._buffer = Buffer.alloc(0);
            console.error('read');
        } else {
            // this._read();
            // Wait for data before pushing
            // process.nextTick(this._read.bind(this))
            setTimeout(this._read.bind(this), 0);
        }
    }

    _write(chunk, encoding, next) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        
        if (this._buffer.length > this._bufferMax) {
            let overrun = this._buffer.length - this._bufferMax;
            this._buffer = this._buffer.slice(overrun, this._buffer.length);
            console.error('buffer overrun by ' + overrun + ' bytes');
        }
        next();
    }
}

// Read process arguments
let lastKey;
if (process.argv.length > 2) {
    for (let i = 2; i < process.argv.length; i++) {
        let arg = process.argv[i];
        if (arg.startsWith('-')) {
            arg = arg.substring(1).toLowerCase();
            lastKey = arg;
            args[arg] = '';
        } else if (lastKey) {
            args[lastKey] = arg;
        }
    }
}

// Display help info
if (args.help != undefined) {
    console.error(`
PCM Buffer
==========
(C) BCC South Africa

Usage: {input process} | node pcm_buffer [arguments] | {output process}
Help: node pcm_buffer -help

Arguments:
-channels:      Number of PCM channels (e.g. -channels 2) [default = 2]
-bitdepth:      PCM bit depth (e.g. -bitdepth 16) [default = 16]
-buffersize:    Buffer size in bytes (e.g. -buffersize 512) [default = 512]
`);
    process.exit();
}

if (args.channels) {
    let c = Number.parseInt(args.channels);
    if (c && c > 0) {
        channels = c;
    } else {
        console.error('Invalid channel specification');
    }
}

if (args.bitdepth) {
    let c = Number.parseInt(args.bitdepth);
    if (c == 16 || c == 24 || c == 32) {
        bitdepth = c;
    } else {
        console.error('Invalid bitdepth specification');
    }
}

if (args.buffersize) {
    let c = Number.parseInt(args.buffersize);
    if (c >= 0) {
        buffersize = c;
    } else {
        console.error('Invalid buffersize specification');
    }
}

console.error(`
Starting PCM Buffer...
Channels: ${channels}
Bit depth: ${bitdepth}
Buffer size: ${buffersize}
`);

const pcmStream = new pcmBuffer(channels, bitdepth, buffersize);

process.stdin.pipe(pcmStream);
pcmStream.pipe(process.stdout);

// process.stdin.on('data', data => {
//     process.stdout.write(data);
// });
