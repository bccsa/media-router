/**
 * Base class for processing base gstreamer functions
 */

const { spawn } = require("child_process");
const psTree = require("ps-tree");

/**
 * SrtBase Class, used as a base class for all shared SRT function
 */
class Spawn {
    constructor() {
        this.stop_cmd = this._stop_cmd; // need to map that child class can access function
        this.start_cmd = this._start_cmd; // need to map that child class can access function
        this._cmd = undefined;
        // Setters
        this.stderrCallback = undefined;
        this.stdoutCallback = undefined;
        this.stdinCallback = undefined;
        this.messageCallback = undefined;
        // Restart backoff state
        this._restartCount = 0;
        this._maxRestarts = 10;
        this._baseRestartDelay = 3000; // 3 seconds
        this._maxRestartDelay = 60000; // 60 seconds cap
        this._successTimer = undefined;
    }

    /**
     * Calculate restart delay with exponential backoff
     * 3s → 6s → 12s → 24s → 48s → 60s (capped)
     */
    _getRestartDelay() {
        return Math.min(
            this._baseRestartDelay * Math.pow(2, this._restartCount),
            this._maxRestartDelay
        );
    }

    /**
     * Spawn's a node subprocess, to start gstreamer (Reason for node sub process, is to avoid crashing the whole process when the c++ process crashes)
     * @param {String} cmd - command to exe
     */
    _start_cmd(cmd) {
        if (!this._cmd && this.ready && this.run) {
            try {
                this._cmd = spawn("/bin/sh", ["-c", cmd], {
                    cwd: "./",
                    stdio: [null, null, null, "ipc"],
                });

                // Reset restart count after 30s of successful running
                clearTimeout(this._successTimer);
                this._successTimer = setTimeout(() => {
                    this._restartCount = 0;
                }, 30000);

                // standard stdout handling
                this._cmd.stdout.on("data", (data) => {
                    this.stdoutCallback
                        ? this.stdoutCallback(data)
                        : console.log(data.toString());
                });

                // standard stderr handling
                this._cmd.stderr.on("data", (data) => {
                    this.stderrCallback
                        ? this.stderrCallback(data)
                        : console.log(data.toString());
                });

                // standard stdin handling
                this._cmd.stdin.on("data", (data) => {
                    this.stdinCallback
                        ? this.stdinCallback(data)
                        : console.log(data.toString());
                });

                // standard message handling
                this._cmd.on("message", ([msg, data]) => {
                    this.messageCallback
                        ? this.messageCallback(msg, data)
                        : console.log(msg, data.toString());
                });

                // Restart pipeline on exit with exponential backoff
                this._cmd.on("exit", (code) => {
                    clearTimeout(this._successTimer);
                    this.stop_cmd();
                    if (this.ready && !(code == null || code == 0)) {
                        if (this._restartCount >= this._maxRestarts) {
                            console.error(
                                `Max restarts (${this._maxRestarts}) reached, not restarting`
                            );
                            return;
                        }
                        const delay = this._getRestartDelay();
                        this._restartCount++;
                        console.log(
                            `Got exit code ${code}, restarting in ${delay / 1000}s (attempt ${this._restartCount}/${this._maxRestarts})`
                        );
                        setTimeout(() => {
                            this.start_cmd(cmd);
                        }, delay);
                    }
                });
            } catch (err) {
                clearTimeout(this._successTimer);
                this.stop_cmd();
                if (this.ready) {
                    if (this._restartCount >= this._maxRestarts) {
                        console.error(
                            `Max restarts (${this._maxRestarts}) reached, not restarting`
                        );
                        return;
                    }
                    const delay = this._getRestartDelay();
                    this._restartCount++;
                    console.log(
                        `error: ${err.message}, restarting in ${delay / 1000}s (attempt ${this._restartCount}/${this._maxRestarts})`
                    );
                    setTimeout(() => {
                        this.start_cmd(cmd);
                    }, delay);
                }
            }
        }
    }

    /**
     * Stop spawned node process.
     * Sends SIGTERM first for graceful shutdown, then SIGKILL after 2 seconds.
     */
    _stop_cmd() {
        if (this._cmd) {
            this._cmd.stdin.pause();
            let pid = this._cmd.pid;
            this._cmd = undefined;

            psTree(pid, function (err, children) {
                const allPids = [pid].concat(
                    children.map(function (p) {
                        return p.PID;
                    })
                );

                // First, send SIGTERM to allow graceful cleanup
                allPids.forEach((tpid) => {
                    try {
                        process.kill(tpid, "SIGTERM");
                    } catch (ex) {
                        // Process may already be dead
                    }
                });

                // After 2 seconds, SIGKILL any survivors
                setTimeout(() => {
                    allPids.forEach((tpid) => {
                        try {
                            process.kill(tpid, 0); // Check if still alive
                            process.kill(tpid, "SIGKILL");
                        } catch (ex) {
                            // Process already exited
                        }
                    });
                }, 2000);
            });
        }
    }
}

module.exports = Spawn;
