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
                linkUrl += `${_firstParam}cname=${link.cname}`;
                _firstParam = "&";
            }
            if (link.buffermin) {
                linkUrl += `${_firstParam}buffer-min=${link.buffermin}`;
                _firstParam = "&";
            }
            if (link.buffermax) {
                linkUrl += `${_firstParam}buffer-max=${link.buffermax}`;
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
};
