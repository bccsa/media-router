const { Readable } = require("stream");
const fs = require('fs');
const net = require('net');

/**
 * Create a readable PCM stream from an existing named pipe
 */
class pcm_pipe_in extends Readable {
    /**
     * Create a readable PCM stream from an existing named pipe
     * @param {string} path - Named pipe path
     * @param {number} channels - Number of PCM channels
     * @param {number} bitdepth - PCM bit depth
     * @param {number} buffersize - Buffer size in bytes
     */
    constructor(path, channels = 1, bitdepth = 16, buffersize = 512) {
        super();
        this._buffer = Buffer.alloc(0);
        this.channels = channels;       // pcm stream channel count
        this.bitdepth = bitdepth;       // pcm stream bit depth
        this.buffersize = buffersize;   // buffer size in bytes
        this._sampleSize = this.channels * this.bitdepth / 8
        this._bufferMax = Math.floor(this.buffersize / this._sampleSize) * this._sampleSize; // buffer size adjusted to sample size
        this._fd;                       // File descriptor number
        this._pipe;                     // Stream
        
        // https://stackoverflow.com/questions/44982499/read-from-a-named-pipe-fifo-with-node-js
        fs.open(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK, (err, fd) => {
            if (err) throw(new Error(err));
            this._fd = fd;
            this._pipe = new net.Socket({ fd });
            
            // Now `pipe` is a stream that can be used for reading from the FIFO.
            this._pipe.on('data', chunk => {
                this._buffer = Buffer.concat([this._buffer, chunk]);

                if (this._buffer.length > this._bufferMax) {
                    let overrun = this._buffer.length - this._bufferMax;
                    this._buffer = this._buffer.slice(overrun, this._buffer.length);
                    console.log('buffer overrun by ' + overrun + ' bytes');
                }
                // console.log('write');
            });
        });
    }

    _read() {
        // Prevent sending an empty buffer and stopping the stream
        if (this._buffer.length > 0) {
            this.push(this._buffer);
            this._buffer = Buffer.alloc(0);
            // console.log('read');
        } else {
            // Wait for data before pushing
            setTimeout(this._read.bind(this), 20);
        }
    }

    close() {
        if (this._pipe && !this._pipe.closed) this._pipe.destroy();
        fs.close(this._fd);
        this.destroy();
    }
}

module.exports.pcm_pipe_in = pcm_pipe_in;