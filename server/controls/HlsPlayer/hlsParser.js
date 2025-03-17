const axios = require("axios");
const HLS = require("hls-parser");

class HlsParser {
    constructor() {
        this.hlsUrl = "";
        this.videoQualities = [];
        this.subtitleLanguages = [];
        this.audioStreams = [];
        this.hlsLoading = false;
    }

    InitHlsParser() {
        this.on("hlsUrl", async (url) => {
            this.hlsLoading = true;
            const res = await this.parse_hls(url);

            if (res?.length) {
                const availableAudio = res.filter((s) => s.type === "audio");
                const availableVideo = res.filter(
                    (s) => s.type === "video" && s.height > 0
                );

                // Remove unavailable sources and maintain enabled states
                this.audioStreams = availableAudio.reduce((arr, s, i) => {
                    if (!arr.some((a) => a.language === s.language)) {
                        const existing = this.audioStreams.find(
                            (a) => a.language === s.language
                        );
                        arr.push({
                            language: s.language,
                            comment: s.name,
                            index: i,
                            enabled: existing ? existing.enabled : false,
                        });
                    }
                    return arr;
                }, []);

                this.videoQualities = availableVideo.map((s) => `${s.height}`);
                this.subtitleLanguages = availableAudio.map((s) => {
                    return { language: s.language, comment: s.name };
                });

                // remove selected sub if it is not in the subtitleLanguages
                if (
                    !this.subtitleLanguages.some(
                        (s) => s.language === this.subtitleLanguage
                    )
                )
                    this.subtitleLanguage = "off";

                // Set default language if not available
                if (
                    !this.audioStreams.some(
                        (c) => c.language === this.defaultLanguage
                    ) &&
                    this.audioStreams.length
                ) {
                    this.defaultLanguage = this.audioStreams[0].language;
                }

                // Set default video quality if not available
                if (
                    !this.videoQualities.includes(this.videoQuality) &&
                    this.videoQualities.length
                ) {
                    this.videoQuality =
                        this.videoQualities[this.videoQualities.length - 1];
                }
                [
                    "audioStreams",
                    "videoQualities",
                    "defaultLanguage",
                    "videoQuality",
                    "subtitleLanguages",
                    "subtitleLanguage",
                ].forEach((prop) => this.NotifyProperty(prop));
            }

            this.hlsLoading = false;
        });
    }

    /**
     * Parse hls url with ffprobe
     * @param {String} url - hls url
     * @returns
     */
    parse_hls(url) {
        return new Promise(async (resolve, reject) => {
            let playlist = await this.fetchPlaylist(url);
            if (!playlist.variants) resolve({});
            else {
                let streams = [];
                for (const v of playlist.variants) {
                    streams.push({
                        type: "video",
                        height: v.resolution.height,
                        codec: v.codecs,
                    });
                }
                for (const a of playlist.variants[0].audio) {
                    streams.push({
                        type: "audio",
                        language: a.language,
                        name: a.name,
                    });
                }

                resolve(streams);
            }
        });
    }

    /**
     * Fetches and parses an HLS playlist from a given URL.
     * @param {string} url - The URL of the HLS playlist.
     * @returns {Promise<object|null>} - The parsed playlist or null if fetching fails.
     */
    async fetchPlaylist(url) {
        try {
            const response = await axios.get(url);
            return HLS.parse(response.data);
        } catch (error) {
            this._parent._log(
                "FATAL",
                `Error fetching playlist: ${error.message}`
            );
            return {};
        }
    }
}

module.exports = HlsParser;
