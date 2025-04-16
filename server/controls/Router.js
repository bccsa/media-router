let { dm, Classes } = require("../modular-dm");
const util = require("util");
const spawn = require("child_process").spawn;
const exec = util.promisify(require("child_process").exec);
const path = require("path");
const psTree = require("ps-tree");
const Resources = require("./Router/resources");
const Logs = require("./Router/logs");
const PulseAudio = require("./Router/pulseaudio");

/**
 * Router control
 */
class Router extends Classes(dm, Resources, Logs, PulseAudio) {
    /**
     * @param {string} path - path to modular-dm control class files. This should be the absolute path to the control files directory or the relative path from the directory where modular-dm is installed.
     */
    constructor(path) {
        super(path);
        this.run = false; // External run command
        this.runCmd = false; // Internal run command
        this.SetAccess("runCmd", { Set: "none", Get: "none" });
        this.displayName = ""; // Used as router username
        this.password = "";
        this.restartCmd = false; // Router restart command. Router process needs passwordless sudo access to the followng command: "sudo reboot now"
        this.resetCmd = false; // Router process reset command. Kills the router.js process. Process should be restarted externally (e.g. via systemd service)
        this.startLocalCTR = false; // Start local control panel on startup (When the MR starts) (!!! This script was build for bookworm / noble / bullseye, if you have a diffrent release update teh script in ./media-router/server/script/startLocalCTR.sh)
        this._paQueue = []; // PulseAudio command rate limiter callback queue
        this._paConnectionCount = 0; // PulseAudio connection counter
        this.startupDelayTime = 3000; // Startup delay time in milliseconds. This is sometimes needed to give other services (e.g. PulseAudio) sufficient time to start up.
        this.startupDelay = true;
        this.startupState = true; // true = Auto (manager selected state); false = Start in stopped state.
        this.SetAccess("log", { Set: "none" }); // Disable Set() access to prevent frontend changing the property (!!! Cant setAccess in extended class, since setAccess in not yet available when class is loaded)
        this.SetAccess("logMessage", { Set: "none" }); // Disable Set() access to prevent frontend changing the property (!!! Cant setAccess in extended class, since setAccess in not yet available when class is loaded)
        this.SetAccess("sinks", { Set: "none" }); // Disable Set() access to prevent frontend changing the property (!!! Cant setAccess in extended class, since setAccess in not yet available when class is loaded)
        this.SetAccess("sources", { Set: "none" }); // Disable Set() access to prevent frontend changing the property (!!! Cant setAccess in extended class, since setAccess in not yet available when class is loaded)
        this.SetMeta("sinks", { guaranteeDelivery: true });
        this.SetMeta("sources", { guaranteeDelivery: true });
        this.SetMeta("log", { guaranteeDelivery: true });
        this.SetMeta("logMessage", { guaranteeDelivery: true });
    }

    Init() {
        super.Init();
        this.InitResources();
        this.InitLogs();
        this.InitPulseAudio();

        // Relay external run command to child controls
        this.on("run", (run) => {
            if (!this.startupDelay) {
                this.runCmd = run;
            }
        });

        // Stop all child controls when the Router control is removed
        this.on("remove", () => {
            this.runCmd = false;
        });

        // Reset command from manager
        this.on("resetCmd", (reset) => {
            if (reset) {
                this.reset = false;
                this.runCmd = false;
                this._log(
                    "INFO",
                    "Reset command received. Resetting router process..."
                );
                this._log("INFO", "Restarting Pipewire");
                exec("systemctl --user restart pipewire").catch((err) => {
                    this._log(
                        "ERROR",
                        "Unable to restart pipewire: " + err.message
                    );
                });
                setTimeout(() => {
                    this._log(
                        "ERROR",
                        "Reset command timeout. Killing router process..."
                    );
                    process.kill("SIGKILL");
                }, 5000);
            }
        });

        // Restart command from manager
        this.on("restartCmd", (restart) => {
            if (restart) {
                restart = false;
                this._log(
                    "INFO",
                    "Reset command received. Resetting router process..."
                );
                exec("sudo reboot now").catch((err) => {
                    this._log(
                        "ERROR",
                        "Unable to reboot router: " + err.message
                    );
                });
            }
        });

        // Start Local Control panel
        let _startLocalCTR_process = undefined;
        this.on(
            "startLocalCTR",
            (s) => {
                if (s && !_startLocalCTR_process) {
                    this._log("INFO", "Starting local control panel");
                    _startLocalCTR_process = spawn(`bash`, [
                        `${path.join(
                            __dirname,
                            "../scripts/start-localCTR.sh"
                        )}`,
                    ]);
                    // standard stderr handeling
                    _startLocalCTR_process.stdout.on("data", (data) => {
                        this._log(
                            "ERROR",
                            `Unable to start local control panel: ${data}`
                        );
                    });
                    // _startLocalCTR_process = exec(`bash ${path.join(__dirname, '../scripts/start-localCTR.sh')}`).catch(err => {
                    //     this._log('ERROR', 'Unable start local control panel: ' + err.message);
                    // });
                } else if (!s && _startLocalCTR_process) {
                    this._log("INFO", "Stopping local control panel");
                    _startLocalCTR_process.stdin.pause();
                    let _this = this;
                    let pid = _startLocalCTR_process.pid;
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
                                    _this._log(
                                        "FATAL",
                                        `${_this._controlName} (${_this.displayName}): ${ex.message}`
                                    );
                                }
                            });
                    });
                    _startLocalCTR_process = undefined;
                }
            },
            { immediate: true }
        );
    }

    /**
     * Rate Limiter for PulseAudio commands. Should be used by all commands interacting with the PulseAudio sound server to prevent overloading the server.
     * @param {*} callback
     * @returns - Promise resolving when the callback has been run or rejecting if the callback fails
     */
    PaCmdQueue(callback) {
        return new Promise((resolve, reject) => {
            // Add callback to queue
            this._paQueue.push({
                callback: callback,
                resolve: resolve,
                reject: reject,
            });

            if (this._paQueue.length == 1) this.paCmdQueueNext(); // Start queue processing on first entry
        });
    }

    /**
     * Execute the next callback from the pulseaudio command rate limiter queue
     */
    paCmdQueueNext() {
        if (this._paQueue.length > 0) {
            let c = this._paQueue[0];
            try {
                // Execute callback from queue
                c.callback();
                c.resolve();
            } catch (err) {
                c.reject(err);
            }
            setTimeout(() => {
                this._paQueue.shift();
                this.paCmdQueueNext();
            }, 200);
        }
    }
}

module.exports = Router;
