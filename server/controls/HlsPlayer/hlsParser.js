const axios = require("axios");
const HLS = require("hls-parser");

class HlsParser {
    constructor() {
        this.hlsUrl = "";
        this.videoQualities = [];
        this.subtitleLanguages = [];
        this.audioStreams = [];
        this.hlsLoading = false;
        this.hlsIsVod = false;
        this.hlsDuration = 0;
        this.hlsStartTime = 0;
        this.hlsCurrentTime = 0;
        this.hlsPaused = false;
    }

    InitHlsParser() {
        this.on("hlsUrl", async (url) => {
            this._suppressStartTimeRestart = true;
            this.hlsStartTime = 0;
            this.hlsCurrentTime = 0;
            this.hlsPaused = false;
            this.NotifyProperty("hlsStartTime");
            this.NotifyProperty("hlsCurrentTime");
            this.NotifyProperty("hlsPaused");
            this._suppressStartTimeRestart = false;
            this.hlsLoading = true;
            const res = await this.parse_hls(url);

            if (res?.length) {
                const availableAudio = res.filter((s) => s.type === "audio");
                const availableSubs = res.filter((s) => s.type === "subtitle");
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
                this.subtitleLanguages = availableSubs.map((s) => {
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

            // Detect VOD and calculate duration
            await this._detectVod(url);

            this.hlsLoading = false;
        });
    }

    /**
     * Fetch a variant playlist to detect VOD (endlist) and calculate total duration.
     * @param {string} url - The master playlist URL.
     */
    async _detectVod(url) {
        try {
            const masterPlaylist = await this.fetchPlaylist(url);
            if (!masterPlaylist.variants || !masterPlaylist.variants.length) {
                this.hlsIsVod = false;
                this.hlsDuration = 0;
                return;
            }

            // Fetch the first variant playlist to check endlist and segment durations
            const variantUrl = new URL(masterPlaylist.variants[0].uri, url).href;
            const variantPlaylist = await this.fetchPlaylist(variantUrl);

            if (!variantPlaylist || !variantPlaylist.segments) {
                this.hlsIsVod = false;
                this.hlsDuration = 0;
                return;
            }

            this.hlsIsVod = variantPlaylist.endlist === true;

            if (this.hlsIsVod) {
                // Sum segment durations to get total duration in seconds
                this.hlsDuration = Math.floor(
                    variantPlaylist.segments.reduce(
                        (sum, seg) => sum + (seg.duration || 0), 0
                    )
                );

                // Clamp startTime if it exceeds new duration
                if (this.hlsStartTime > this.hlsDuration) {
                    this._suppressStartTimeRestart = true;
                    this.hlsStartTime = 0;
                    this._suppressStartTimeRestart = false;
                }
            } else {
                this.hlsDuration = 0;
                this.hlsStartTime = 0;
            }

            ["hlsIsVod", "hlsDuration", "hlsStartTime"].forEach(
                (prop) => this.NotifyProperty(prop)
            );
        } catch (error) {
            this._parent._log(
                "ERROR",
                `VOD detection failed: ${error.message}`
            );
            this.hlsIsVod = false;
            this.hlsDuration = 0;
        }
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
                for (const a of playlist.variants[0].subtitles) {
                    streams.push({
                        type: "subtitle",
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
