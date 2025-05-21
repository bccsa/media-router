module.exports = {
    /**
     * Generate the URL for the RIST links
     * @param {Array} links - Array of RIST links controls
     * @returns
     */
    url: (links) => {
        let url = "";
        let firstParam = "";
        Object.values(links).forEach((link) => {
            let _firstParam = "?";
            let linkUrl = "rist://";
            if ((link.mode == "caller" && !link.host) || !link.port) return;
            if (link.mode == "listener") {
                linkUrl += `@[::]:${link.port}`;
            } else {
                linkUrl += `${link.host}:${link.port}`;
            }
            if (link.cname) {
                linkUrl += `${_firstParam}cname=${link._parent._parent.displayName}_${link.cname}`;
                _firstParam = "&";
            } else {
                linkUrl += `${_firstParam}cname=${link._parent._parent.displayName}_${link._parent.displayName}`;
                _firstParam = "&";
            }
            // if (link.buffermin) {
            //     linkUrl += `${_firstParam}buffer-min=${link.buffermin}`;
            //     _firstParam = "&";
            // }
            // if (link.buffermax) {
            //     linkUrl += `${_firstParam}buffer-max=${link.buffermax}`;
            //     _firstParam = "&";
            // }
            if (link.buffer) {
                linkUrl += `${_firstParam}buffer=${link.buffer}`;
                _firstParam = "&";
            }
            if (link.weight) {
                linkUrl += `${_firstParam}weight=${link.weight}`;
                _firstParam = "&";
            }

            url += `${firstParam}${linkUrl}`;
            firstParam = ",";
        });

        return url;
    },

    parseStats: (stats) => {
        if (!stats) return;
        const data = stats.toString();
        if (!data) return;
        const parsedObjects = data
            .trim()
            .split("\n")
            .filter((line) => line.includes("{") && line.includes("}")) // keep only lines with JSON
            .map((line) => {
                const [, , jsonStr] = line.split("|");
                try {
                    const json = JSON.parse(jsonStr.trim().split("[INFO]")[1]);
                    return json;
                } catch (e) {
                    return null; // skip malformed JSON just in case
                }
            })
            .filter((obj) => obj !== null); // remove null entries

        if (!parsedObjects || parsedObjects.length == 0) return;
        return parsedObjects;
    },

    senderStats(stats) {
        if (!stats) return [];
        try {
            const data = [];
            stats.forEach((s) => {
                const stat = s["sender-stats"].peer;
                const res = {};
                res.id = stat.id;
                res.cname = stat.cname;
                res.quality = stat["stats"].quality;
                res.bitrate =
                    Math.round((stat["stats"].bandwidth / 1000000) * 100) / 100;
                res.rtt = stat["stats"].avg_rtt;
                res.status = "running";
                res.controlType = "RistStats";
                res.timestamp = Date.now();

                data.push(res);
            });
            return data;
        } catch (e) {
            return [];
        }
    },

    receiverStats(stats) {
        if (!stats) return [];
        try {
            const data = [];
            stats.forEach((s) => {
                if (!s["receiver-stats"]) return;
                const stat = s["receiver-stats"].flowinstant;
                const quality = stat["stats"].quality;

                stat.peers.forEach((peer) => {
                    const res = {};

                    res.id = peer.id;
                    res.cname = `Link ${peer.id}`;
                    res.rtt = peer["stats"].avg_rtt;
                    res.bitrate =
                        Math.round(
                            (peer["stats"].avg_bitrate / 1000000) * 100
                        ) / 100;
                    res.quality = quality;
                    res.status = "running";
                    res.controlType = "RistStats";
                    res.timestamp = Date.now();
                    data.push(res);
                });
            });
            return data;
        } catch (e) {
            return [];
        }
    },
};
