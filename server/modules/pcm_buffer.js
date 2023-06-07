const { Transform } = require("stream");

class pcm_buffer extends Transform {
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
        } else {
            // Wait for data before pushing
            setTimeout(this._read.bind(this), 20);
        }
    }

    _write(chunk, encoding, next) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        
        if (this._buffer.length > this._bufferMax) {
            let overrun = this._buffer.length - this._bufferMax;
            this._buffer = this._buffer.slice(overrun, this._buffer.length);
            console.log('buffer overrun by ' + overrun + ' bytes');
        }
        next();
        // setTimeout(() => { next() }, 20);
    }
}

module.exports.pcm_buffer = pcm_buffer;