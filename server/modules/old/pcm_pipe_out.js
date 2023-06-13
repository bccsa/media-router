const { Writable } = require("stream");
const fs = require('fs');
const net = require('net');

/**
 * Create a writable PCM stream from an existing named pipe
 */
class pcm_pipe_out extends Writable {
    /**
     * Create a writable PCM stream from an existing named pipe
     * @param {string} path - Named pipe path
     */
    constructor(path) {
        super();
        this._fd;   // File descriptor number
        this._pipe; // Stream

        fs.open(path, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK, (err, fd) => {
            if (err) throw(new Error(err));
            this._fd = fd;
            this._pipe = new net.Socket({ fd });
        });
    }

    _write(chunk, encoding, next) {
        if (this._pipe && !this._pipe.closed) {
            this._pipe.write(chunk);
        }

        next();
    }

    close() {
        if (this._pipe && !this._pipe.closed) this._pipe.destroy();
        fs.close(this._fd);
        this.destroy();
    }
}

module.exports.pcm_pipe_out = pcm_pipe_out;