const si = require("systeminformation");
const fs = require("fs");
const os_utils = require("os-utils");
const os = require("os");
const path = require("path");

class Resources {
    constructor() {
        this.cpuUsage = 0; // CPU usage indication
        this.cpuTemperature = 0; // CPU temperature indication
        this.memoryUsage = 0; // Memory usage indication
        this.udpPorts = [];
        this.tcpPorts = [];
        this.ipAddress = "127.0.0.1"; // system IP address
        this.buildNumber = "DEV"; // Software Build number
    }

    InitResources() {
        //----------------------Get device resources-----------------------------//
        // CPU usage
        setInterval(() => {
            os_utils.cpuUsage((v) => {
                this.cpuUsage = Math.round(v * 100);
            });
        }, 2000);

        // CPU temperature
        setInterval(() => {
            si.cpuTemperature()
                .then((data) => {
                    this.cpuTemperature = Math.round(data.main);
                })
                .catch((err) => {
                    this._log(
                        "ERROR",
                        "Unable to get CPU temperature: " + err.message
                    );
                });
        }, 2000);

        // memory usage
        setInterval(() => {
            si.mem()
                .then((data) => {
                    this.memoryUsage = Math.round(
                        (data.active / data.total) * 100
                    );
                })
                .catch((err) => {
                    this._log(
                        "ERROR",
                        "Unable to get memory usage: " + err.message
                    );
                });
        }, 2000);

        // IP address
        setTimeout(() => {
            this._getIP().then((ip) => {
                this.ipAddress = ip;
            });
        }, 5000);
        setInterval(() => {
            this._getIP().then((ip) => {
                this.ipAddress = ip;
            });
        }, 10000);

        // Load Build Number (Timeout is to run this on the next tick to otherwise it does not sync through to the manager)
        setTimeout(() => {
            try {
                this.buildNumber = fs
                    .readFileSync(
                        path.join(__dirname, "../../../build-number.txt"),
                        "utf8"
                    )
                    .toString()
                    .replace(/\r?\n|\r/g, "");
            } catch (err) {
                this._log(
                    "ERROR",
                    "Unable to load build numebr: " + err.message
                );
                this.buildNumber = "DEV";
            }
        }, 5000);
        //----------------------Get device resources-----------------------------//
    }

    /**
     * Get device ip Address
     */
    _getIP() {
        return new Promise((resolve, reject) => {
            let interfaces = os.networkInterfaces();
            Object.values(interfaces).forEach((iface) => {
                for (var i = 0; i < iface.length; i++) {
                    var alias = iface[i];
                    if (
                        alias.family === "IPv4" &&
                        alias.address !== "127.0.0.1" &&
                        !alias.internal
                    )
                        resolve(alias.address);
                }
            });
        });
    }
}

module.exports = Resources;
