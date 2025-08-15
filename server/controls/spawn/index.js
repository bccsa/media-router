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

                // Restart pipeline on exit
                this._cmd.on("exit", (code) => {
                    this.stop_cmd();
                    if (this.ready && !(code == null || code == 0)) {
                        console.log("Got exit code, restarting in 3s");
                        setTimeout(() => {
                            this.start_cmd(cmd);
                        }, 3000);
                    }
                });
            } catch (err) {
                this.stop_cmd();
                if (this.ready) {
                    console.log(`error: ${err.message}, restarting in 3s`);
                    setTimeout(() => {
                        this.start_cmd(cmd);
                    }, 3000);
                }
            }
        }
    }

    /**
     * Stop spawned node process
     */
    _stop_cmd() {
        if (this._cmd) {
            this._cmd.stdin.pause();
            let pid = this._cmd.pid;
            psTree(pid, function (err, children) {
                // Solution found here: https://stackoverflow.com/questions/18694684/spawn-and-kill-a-process-in-node-js
                [pid]
                    .concat(
                        children.map(function (p) {
                            return p.PID;
                        })
                    )
                    .forEach((tpid) => {
                        try {
                            process.kill(tpid, "SIGKILL");
                        } catch (ex) {
                            console.log(
                                `Error killing process ${tpid}: ${ex.message}`
                            );
                        }
                    });
            });
            this._cmd = undefined;
        }
    }
}

module.exports = Spawn;
