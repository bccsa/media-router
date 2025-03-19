class Resources {
    constructor() {
        this.cpuUsage = 0; // CPU usage indication
        this.cpuTemperature = 0; // CPU temperature indication
        this.memoryUsage = 0; // Memory usage indication
        this.ipAddress = "127.0.0.1"; // system IP address
        this.buildNumber = "DEV"; // buildNumber Build number
        this._udp = {};
        this._tcp = {};
    }

    InitResources() {
        const h = (obj, val, disaster, warning) => {
            // red
            if (val > disaster) obj.style.backgroundColor = "rgb(185 28 28)";
            // orange
            else if (val > warning)
                obj.style.backgroundColor = "rgb(245 158 11)";
            // gray
            else obj.style.backgroundColor = "rgb(203 213 225)";
        };

        // Memory Usage indicator
        this.on(
            "memoryUsage",
            (v) => {
                h(this._memoryUsage, v, 80, 50);
            },
            { immediate: true }
        );

        // Handle CPU load indicator
        this.on(
            "cpuUsage",
            (v) => {
                h(this._cpuUsage, v, 80, 50);
            },
            { immediate: true }
        );

        // Handle CPU temp indicator
        this.on(
            "cpuTemperature",
            (v) => {
                h(this._cpuTemperature, v, 85, 70);
            },
            { immediate: true }
        );
    }

    /**
     * modules need to publish a port, to make sure no duplicate ports is used
     * @param {string} moduleName - module name
     * @param {string} protocol - udp/tcp
     * @param {number} port - port number
     */
    publishPort(moduleName, protocol, port) {
        this.cleanPorts();

        if (protocol !== "udp" && protocol !== "tcp") return "Invalid protocol";

        const proto = this[`_${protocol}`];
        const portInUse = Object.values(proto).find((p) => p.port == port);
        if (!portInUse) {
            proto[moduleName] = { moduleName, port };
            return "";
        }

        // return empty if module is the one using the port
        if (portInUse && portInUse.moduleName == moduleName) return "";

        return `Port is in use by ${portInUse.moduleName}`;
    }

    /**
     * Remove module mort from list
     */
    unpublishPort(moduleName, protocol) {
        if (protocol !== "udp" && protocol !== "tcp") return "Invalid protocol";
        const proto = this[`_${protocol}`];
        delete proto[moduleName];
    }

    /**
     * remove unused ports from lists (Typically when a module is deleted)
     */
    cleanPorts() {
        // cleanup old ports
        // UDP:
        Object.keys(this._udp).forEach((k) => {
            if (!this[k]) delete this._udp[k];
        });

        // TCP:
        Object.keys(this._tcp).forEach((k) => {
            if (!this[k]) delete this._tcp[k];
        });
    }

    /**
     * Check if device is online or offline
     */
    _checkOnline() {
        if (this.online) {
            this._online.style.display = "inline-flex";
            this._offline.style.display = "none";
        } else {
            this._online.style.display = "none";
            this._offline.style.display = "inline-flex";
        }
    }
}

module.exports = Resources;
