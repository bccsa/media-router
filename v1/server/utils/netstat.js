/**
 * Module to convert netstat output to json format
 */
const child = require("child_process");

/**
 * Get Netstat output
 */
const runNetstat = () => {
    return new Promise((resolve) => {
        let out = "";
        const netstat = child.spawn("netstat", ["-ano"]);

        netstat.stdout.on("data", function (data) {
            out += data;
            resolve(out);
        });
        netstat.stderr.on("data", function (data) {
            console.log("err: " + data);
            resolve(out);
        });
        netstat.on("exit", function (code) {
            if (code !== 0) {
                console.log("!!! exited, status code: " + code);
                resolve(out);
            }
        });
    });
};

/**
 * Convert netstat output to json
 * @param {String} output - Netstat output
 * @returns
 */
const netstatToJson = (output) => {
    const lines = output.trim().split("\n");
    const portsByProtocol = {
        tcp: new Set(),
        tcp6: new Set(),
        udp: new Set(),
        udp6: new Set(),
    };

    // More flexible patterns to match various port formats
    const pattern =
        /^(\w+)\s+\d+\s+\d+\s+(?:(?:\d+\.\d+\.\d+\.\d+)|(?:\[?::\]?|\[?::1\]?)):(\d+|\*)/;

    for (const line of lines) {
        const trimmedLine = line.trim();

        const m = trimmedLine.match(pattern);

        if (m) {
            const [, protocol, port] = m;
            if (
                protocol == "tcp" ||
                protocol == "tcp6" ||
                protocol == "udp" ||
                protocol == "udp6"
            )
                portsByProtocol[protocol].add(port);
        }
    }

    // Convert Sets to Arrays and sort numerically
    return {
        tcp: Array.from(portsByProtocol.tcp).sort(
            (a, b) => Number(a) - Number(b)
        ),
        tcp6: Array.from(portsByProtocol.tcp6).sort(
            (a, b) => Number(a) - Number(b)
        ),
        udp: Array.from(portsByProtocol.udp).sort(
            (a, b) => Number(a) - Number(b)
        ),
        udp6: Array.from(portsByProtocol.udp6).sort(
            (a, b) => Number(a) - Number(b)
        ),
    };
};

module.exports = {
    netstat: () => {
        return new Promise((resolve) => {
            runNetstat().then((res) => {
                resolve(netstatToJson(res));
            });
        });
    },
};

const tin = async () => {
    const res = await module.exports.netstat();
    console.log(res);
};

tin();
