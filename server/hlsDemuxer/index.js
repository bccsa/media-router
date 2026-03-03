/**
 * HLS Demuxer
 *
 * This script fetches and processes an HLS stream, dynamically selecting the best video variant based on estimated bandwidth.
 * It creates named pipes (FIFO) to output video, audio, and subtitle streams, which can be read by external media players.
 *
 * To read the video stream with GStreamer, use the following pipeline:
 *
 * gst-launch-1.0 filesrc location="/tmp/videoPipe" ! parsebin ! decodebin ! kmssink sync=true
 *
 * The script also handles adaptive bitrate switching and retries failed segment downloads.
 */
const axios = require("axios");
const HLS = require("hls-parser");
const fs = require("fs");
const util = require("util");
const exec = util.promisify(require("child_process").exec);
const path = require("path");

const MAX_RETRIES = 5;
const MAX_PLAYLIST_RETRIES = 20;

// Axios instance with default timeout to prevent hanging on unresponsive servers
const http = axios.create({ timeout: 15000 });

// ==================== ABR Controller ====================
// Dual-EWMA bandwidth estimator (same approach as hls.js / Shaka Player)
// with asymmetric switch thresholds and minimum hold time to prevent oscillation.
const abr = {
    // Dual EWMA state
    fastEWMA: null,
    slowEWMA: null,
    fastHalfLife: 3.0,   // seconds — reacts quickly to bandwidth drops
    slowHalfLife: 9.0,   // seconds — smoothed, prevents false upgrades
    totalWeight: 0,
    defaultEstimate: 2_000_000, // 2 Mbps until enough samples

    // Asymmetric switch thresholds (hysteresis)
    switchUpFactor: 0.70,   // upgrade only when BW > variant / 0.70 (~143% of variant)
    switchDownFactor: 0.85, // downgrade when BW < variant / 0.85 (~118% of variant)

    // Minimum time between quality switches
    minSwitchIntervalMs: 10000, // 10 seconds
    lastSwitchTime: 0,

    // Oscillation detection
    switchHistory: [],     // +1 = upgrade, -1 = downgrade
    maxSwitchHistory: 5,

    // Minimum sample size to avoid noisy measurements
    minSampleBytes: 64 * 1024,  // 64 KB
    minSampleTimeMs: 100,       // 100ms

    _alpha(halfLife) {
        return Math.exp(Math.log(0.5) / halfLife);
    },

    addSample(downloadBytes, downloadTimeMs) {
        if (downloadBytes < this.minSampleBytes || downloadTimeMs < this.minSampleTimeMs) {
            return;
        }

        const durationSec = downloadTimeMs / 1000;
        const bandwidthBps = (downloadBytes * 8) / durationSec;

        if (this.fastEWMA === null) {
            this.fastEWMA = bandwidthBps;
            this.slowEWMA = bandwidthBps;
        } else {
            // Weight by download duration — longer downloads are more reliable
            const fastAlpha = Math.pow(this._alpha(this.fastHalfLife), durationSec);
            this.fastEWMA = bandwidthBps * (1 - fastAlpha) + this.fastEWMA * fastAlpha;

            const slowAlpha = Math.pow(this._alpha(this.slowHalfLife), durationSec);
            this.slowEWMA = bandwidthBps * (1 - slowAlpha) + this.slowEWMA * slowAlpha;
        }
        this.totalWeight += durationSec;
    },

    getEstimate() {
        if (this.totalWeight < 1.0 || this.fastEWMA === null) {
            return this.defaultEstimate;
        }
        // Take the minimum: drops fast (fast EWMA reacts), climbs slowly (slow EWMA restrains)
        return Math.min(this.fastEWMA, this.slowEWMA);
    },

    _isOscillating() {
        if (this.switchHistory.length < 3) return false;
        let changes = 0;
        for (let i = 1; i < this.switchHistory.length; i++) {
            if (this.switchHistory[i] !== this.switchHistory[i - 1]) {
                changes++;
            }
        }
        return changes >= 3;
    },

    _recordSwitch(direction) {
        this.switchHistory.push(direction);
        if (this.switchHistory.length > this.maxSwitchHistory) {
            this.switchHistory.shift();
        }
    },
};

if (process.argv.length < 3) {
    console.error("Usage: node index.js <HLS_URL> config (JSON Object)");
    process.exit(1);
}

/**
 * Config
 * languages: Array<string>
 * maxQuality: number
 * subtitleTrack: string - (Optional)
 * moduleIdentifier: string - this is used to give pipes unique names (Optional)
 */
const config = JSON.parse(process.argv[3]);
const hlsUrl = process.argv[2];

if (!hlsUrl) {
    console.error("Error: HLS URL is required");
    process.exit(1);
}

const preferredAudioLangs = Array.isArray(config.languages) ? config.languages : [];
const subtitleLanguage = config.subtitleLanguage || "";
const moduleIdentifier = config.moduleIdentifier || "";
let currentVariant = null;    // Full variant object (has .uri, .audio, .subtitles, .bandwidth, .resolution)
let masterPlaylist = null;
let selectedAudioTracks = null;
let selectedSubtitleTracks = null;
let isVod = false;

/**
 * Fetches and parses an HLS playlist from a given URL.
 * @param {string} url - The URL of the HLS playlist.
 * @returns {Promise<object|null>} - The parsed playlist or null if fetching fails.
 */
async function fetchPlaylist(url) {
    const _url = new URL(url, hlsUrl).href;
    try {
        const response = await http.get(_url);
        return HLS.parse(response.data);
    } catch (error) {
        console.error(`Error fetching playlist: ${error.message}`);
        return null;
    }
}

async function fetchSegmentList(stream) {
    let retries = 0;

    while (retries < MAX_PLAYLIST_RETRIES) {
        if (!isVod) {
            stream.playlist = await fetchPlaylist(stream.url);

            if (!stream.playlist) {
                retries++;
                console.warn(`Playlist fetch failed (attempt ${retries}/${MAX_PLAYLIST_RETRIES})`);
                await new Promise((res) => setTimeout(res, 1000));
                continue;
            }

            // Use HLS spec endlist tag instead of segment count heuristic
            isVod = stream.playlist.endlist === true;
        }

        if (!isVod) return stream.playlist;

        if (!stream.playlist) {
            retries++;
            console.warn(`VOD playlist unavailable (attempt ${retries}/${MAX_PLAYLIST_RETRIES})`);
            await new Promise((res) => setTimeout(res, 1000));
            continue;
        }

        if (stream.playlist.segments.length > 0) {
            // Create a shallow copy with only the needed segments to reduce memory usage
            const p = {
                ...stream.playlist,
                segments: stream.playlist.segments.slice(
                    stream.pointer,
                    stream.pointer + stream.page
                ),
            };
            stream.pointer += stream.page;

            return p;
        }

        return stream.playlist;
    }

    console.error(`Max playlist retries (${MAX_PLAYLIST_RETRIES}) exceeded`);
    return null;
}

/**
 * Selects the best video variant using dual-EWMA bandwidth estimation with
 * asymmetric switch thresholds, minimum hold time, and oscillation detection.
 */
async function selectBestVariant() {
    if (!masterPlaylist || !masterPlaylist.isMasterPlaylist) return;

    const bw = abr.getEstimate();

    // Filter variants within maxQuality and sort by bandwidth ascending
    const eligible = masterPlaylist.variants
        .filter((v) => v.resolution.height <= config.maxQuality)
        .sort((a, b) => a.bandwidth - b.bandwidth);

    if (eligible.length === 0) return;

    // Find current variant index
    const currentUri = currentVariant ? currentVariant.uri : null;
    const currentIndex = eligible.findIndex((v) => v.uri === currentUri);

    // Determine ideal variant with asymmetric thresholds
    let idealIndex = 0;
    for (let i = eligible.length - 1; i >= 0; i--) {
        if (i > currentIndex) {
            // Upgrade: more conservative — need BW > variant / switchUpFactor
            if (bw * abr.switchUpFactor >= eligible[i].bandwidth) {
                idealIndex = i;
                break;
            }
        } else {
            // Current or downgrade: less conservative
            if (bw * abr.switchDownFactor >= eligible[i].bandwidth) {
                idealIndex = i;
                break;
            }
        }
    }

    const bestVariant = eligible[idealIndex];

    // Check if a switch is needed
    if (currentUri === bestVariant.uri) return;

    const isUpgrade = idealIndex > currentIndex;
    const now = Date.now();

    // Enforce minimum hold time (always allow downgrade on first selection)
    if (currentVariant !== null && now - abr.lastSwitchTime < abr.minSwitchIntervalMs) {
        return;
    }

    // Suppress upgrades when oscillating
    if (isUpgrade && abr._isOscillating()) {
        return;
    }

    // Apply the switch
    console.log(
        `Switching to Variant: ${bestVariant.resolution?.height}p @ ${
            bestVariant.bandwidth / 1000
        } Kbps (BW estimate: ${Math.round(bw / 1000)} Kbps)`
    );

    abr._recordSwitch(isUpgrade ? 1 : -1);
    abr.lastSwitchTime = now;

    currentVariant = null;
    currentVariant = bestVariant;

    // Update VOD segments if quality changes
    if (isVod && streams[0]) {
        streams[0].playlist = null;
        streams[0].url = null;
        streams[0].url = new URL(currentVariant.uri, hlsUrl).href;
        streams[0].playlist = await fetchPlaylist(currentVariant.uri);
    }
}

/**
 * Selects the preferred audio tracks based on user preferences.
 * @returns {object} - Selected audio tracks.
 */
async function selectAudioTracks() {
    if (!masterPlaylist || !masterPlaylist.isMasterPlaylist) return {};
    if (!currentVariant || !currentVariant.audio) return {};
    const selectedTracks = {};

    let count = 1;
    for (const track of currentVariant.audio) {
        if (
            preferredAudioLangs.length === 0 ||
            preferredAudioLangs.includes(track.language)
        ) {
            selectedTracks[track.language] = track;
            if (streams[count]) {
                // Clear old references to prevent memory leak
                streams[count].uri = null;
                streams[count].playlist = null;

                // Set new references
                streams[count].uri = new URL(track.uri, hlsUrl).href;
                streams[count].playlist = await fetchPlaylist(
                    streams[count].uri
                );
            }
            count++;
        }
    }

    return selectedTracks;
}

/**
 * Selects the preferred subtitle tracks based on user preferences.
 * @returns {object} - Selected subtitle tracks.
 */
async function selectSubtitleTracks() {
    if (!masterPlaylist || !masterPlaylist.isMasterPlaylist) return {};
    if (!currentVariant || !currentVariant.subtitles) return {};
    const selectedTracks = {};

    for (const track of currentVariant.subtitles) {
        if (subtitleLanguage === track.language) {
            selectedTracks[track.language] = track;
        }
    }

    return selectedTracks;
}

/**
 * Fetches a media segment and pipes it to the provided writable stream.
 * @param {string} segmentUrl - The URL of the segment.
 * @param {fs.WriteStream} pipe - The writable stream.
 * @param {boolean} isVideo - Whether the segment is video or audio.
 * @param {number} [retryCount=0] - The current retry attempt.
 */
async function fetchSegment(segmentUrl, pipe, isVideo, retryCount = 0) {
    try {
        const startTime = Date.now();
        const response = await http.get(segmentUrl, {
            responseType: "arraybuffer",
        });
        const downloadEndTime = Date.now();
        const buffer = Buffer.from(response.data);

        // Wait for drain if pipe buffer is full (backpressure)
        if (pipe.writableLength > pipe.writableHighWaterMark) {
            await new Promise((resolve, reject) => {
                pipe.once("drain", resolve);
                pipe.once("error", reject);
            });
        }

        const ok = pipe.write(buffer);
        if (!ok) {
            // Buffer full — wait for drain before continuing
            await new Promise((resolve, reject) => {
                const onDrain = () => { pipe.removeListener("error", onError); resolve(); };
                const onError = (err) => { pipe.removeListener("drain", onDrain); reject(err); };
                pipe.once("drain", onDrain);
                pipe.once("error", onError);
            });
        }

        // Feed bandwidth sample to ABR controller (video segments only)
        if (isVideo) {
            const downloadTimeMs = downloadEndTime - startTime;
            abr.addSample(buffer.length, downloadTimeMs);
            await selectBestVariant();
        }
    } catch (error) {
        console.error(
            `Failed to fetch segment: ${segmentUrl} - ${error.message}`
        );
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying... Attempt ${retryCount + 1}`);
            await new Promise((res) => setTimeout(res, 1000));
            return fetchSegment(segmentUrl, pipe, isVideo, retryCount + 1);
        } else {
            console.log("Max retries reached. skipping segment...");
            return;
        }
    }
}

/**
 * Fetches and writes the init segment (EXT-X-MAP) only when it changes.
 * This happens once at the start and again if ABR switches to a different variant.
 * @param {object} stream - The stream object
 * @param {object} playlist - The parsed playlist with source text
 */
async function handleInitSegment(stream, playlist) {
    const map = playlist.source.match(/(?<=EXT-X-MAP:URI=")(.*)(?=")/gm);
    if (!map) return;

    const initUrl = new URL(map[0], stream.url).href;

    if (initUrl !== stream.lastInitSegmentUrl) {
        stream.lastInitSegmentUrl = initUrl;
        await fetchSegment(initUrl, stream.pipe, stream.isVideo);
        console.log(
            `Init segment written for ${stream.language || "video"}: ${initUrl}`
        );
    }
}

/**
 * Streams all streams in lockstep, fetching segments for the same media
 * sequence number across all streams before advancing. This ensures audio
 * channels stay in sync with each other and with video.
 * @param {Array} streams - Array of stream objects
 */
async function streamAllSynchronized(streams) {
    let lastSeqNumbers = streams.map(() => 0);
    let running = true;

    do {
        // 1. Fetch all playlists in parallel
        const playlists = await Promise.all(
            streams.map((s) => fetchSegmentList(s))
        );

        // Skip cycle if any playlist failed
        if (playlists.some((p) => !p)) {
            await new Promise((res) => setTimeout(res, 1000));
            continue;
        }

        // 2. For live streams starting up, pick a common starting point
        if (!isVod && lastSeqNumbers.every((n) => n === 0)) {
            let startSeq = 0;
            for (let i = 0; i < playlists.length; i++) {
                const segs = playlists[i].segments;
                if (segs.length > 0) {
                    const mid =
                        segs[Math.floor(segs.length / 2)]
                            .mediaSequenceNumber;
                    startSeq = Math.max(startSeq, mid);
                }
            }
            lastSeqNumbers = lastSeqNumbers.map(() => startSeq);
        }

        // 3. Filter each playlist to only new segments
        const filteredSegments = playlists.map((p, i) =>
            p.segments.filter(
                (s) => s.mediaSequenceNumber > lastSeqNumbers[i]
            )
        );

        // 4. Find common media sequence numbers available across ALL streams
        const seqSets = filteredSegments.map(
            (segs) => new Set(segs.map((s) => s.mediaSequenceNumber))
        );

        let commonSeqs = [];
        if (seqSets.length > 0 && seqSets[0].size > 0) {
            commonSeqs = [...seqSets[0]].filter((seq) =>
                seqSets.every((set) => set.has(seq))
            );
            commonSeqs.sort((a, b) => a - b);
        }

        // 5. For each common sequence, download all streams' segments in parallel
        for (const seq of commonSeqs) {
            await Promise.all(
                streams.map(async (stream, i) => {
                    const segment = filteredSegments[i].find(
                        (s) => s.mediaSequenceNumber === seq
                    );
                    if (!segment) return;

                    // Write init segment if needed (only on first run or variant change)
                    await handleInitSegment(stream, playlists[i]);

                    const segmentUrl = new URL(segment.uri, stream.url).href;
                    await fetchSegment(segmentUrl, stream.pipe, stream.isVideo);
                })
            );

            // Update all sequence numbers together
            lastSeqNumbers = lastSeqNumbers.map(() => seq);
        }

        // 6. Wait before next poll
        await new Promise((res) => setTimeout(res, 1000));

        // 7. Check if VOD is finished
        running =
            !isVod || filteredSegments.some((segs) => segs.length > 0);
    } while (running);

    console.log("All streams finished");
}

let streams = [];

/**
 * Initializes and starts video, audio, and subtitle streams.
 */
async function startStreams() {
    masterPlaylist = await fetchPlaylist(hlsUrl);
    await selectBestVariant();
    selectedAudioTracks = await selectAudioTracks();
    selectedSubtitleTracks = await selectSubtitleTracks();
    const pipe = (moduleIdentifier ? moduleIdentifier + "_" : "") + `videoPipe`;
    const videoPipe = await createPipe(pipe);

    streams.push({
        index: 0,
        url: new URL(currentVariant.uri, hlsUrl).href,
        pointer: 0,
        page: 3,
        isVideo: true,
        pipe: videoPipe,
        isVod: false,
        playlist: undefined,
        lastInitSegmentUrl: null,
    });

    let count = 1;

    for (const track of Object.values(selectedAudioTracks)) {
        let pipe =
            (moduleIdentifier ? moduleIdentifier + "_" : "") +
            `${track.language}_audioPipe`;
        const audioPipe = await createPipe(pipe);
        streams.push({
            index: count,
            url: new URL(track.uri, hlsUrl).href,
            pointer: 0,
            page: 36,
            isVideo: false,
            pipe: audioPipe,
            isVod: false,
            playlist: undefined,
            language: track.language,
            lastInitSegmentUrl: null,
        });
        count++;
    }

    for (const track of Object.values(selectedSubtitleTracks)) {
        let pipe =
            (moduleIdentifier ? moduleIdentifier + "_" : "") +
            `${track.language}_subtitlePipe`;
        const subtitlePipe = await createPipe(pipe);
        streams.push({
            index: count,
            url: new URL(track.uri, hlsUrl).href,
            pointer: 0,
            page: 36,
            isVideo: false,
            pipe: subtitlePipe,
            isVod: false,
            playlist: undefined,
            language: track.language,
            isSub: true,
            lastInitSegmentUrl: null,
        });
        count++;
    }
    // Signal that all pipes are created and ready for GStreamer to open
    const markerPath = `/tmp/${moduleIdentifier || "hls"}_hls_ready`;
    fs.writeFileSync(markerPath, "");
    console.log("HLS_DEMUXER_READY");

    await streamAllSynchronized(streams);
    streams.forEach((s) => s.pipe.end());
}

startStreams();

let pipeMaxSizeSet = false;

/**
 * Removes and creates a new FIFO pipe.
 * Sets system pipe-max-size once, and schedules per-pipe sizing
 * for after GStreamer opens the read end.
 */
async function createPipe(pipeName) {
    const pipePath = `/tmp/${pipeName}`;
    try {
        await exec(`rm -f ${pipePath}`);
    } catch (err) {}

    await exec(`mkfifo ${pipePath}`);

    // Set system pipe-max-size once (doesn't need an open fd)
    if (!pipeMaxSizeSet) {
        try {
            await exec(`echo 33554432 | sudo tee /proc/sys/fs/pipe-max-size`);
        } catch (err) {
            console.warn(`Warning: Could not set pipe-max-size: ${err.message}`);
        }
        pipeMaxSizeSet = true;
    }

    const _pipe = fs.createWriteStream(pipePath, {
        flags: "a",
    });

    _pipe.on("error", (err) => {
        if (err.code === "EPIPE") {
            console.warn(`Warning: Broken pipe on ${pipePath}, reader disconnected`);
            // Don't exit — let fetchSegment's catch handle the write error via retry
        } else {
            console.error(`WriteStream Error on ${pipePath}:`, err);
        }
    });

    // Set FIFO buffer size after GStreamer opens the read end.
    // GStreamer starts once the ready marker is detected (~0.5s after this function),
    // so 3 seconds gives enough time for it to open the pipes.
    setTimeout(async () => {
        try {
            await exec(`${path.dirname(process.argv[1])}/setfifo ${pipePath} 20000000`);
        } catch (err) {
            console.warn(`Warning: Could not set FIFO size for ${pipePath}: ${err.message}`);
        }
    }, 3000);

    return _pipe;
}

process.on("unhandledRejection", console.log);

// Add cleanup handlers
process.on("SIGINT", () => {
    console.log("Received SIGINT, cleaning up...");
    cleanup();
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("Received SIGTERM, cleaning up...");
    cleanup();
    process.exit(0);
});

process.on("exit", () => {
    cleanup();
});

/**
 * Cleanup function to release memory references
 */
function cleanup() {
    // Clear all stream references
    if (streams) {
        streams.forEach((stream) => {
            if (stream.playlist) {
                stream.playlist = null;
            }
            if (stream.pipe) {
                stream.pipe.end();
                stream.pipe = null;
            }
            stream.url = null;
        });
        streams = null;
    }

    // Remove readiness marker file
    const markerPath = `/tmp/${moduleIdentifier || "hls"}_hls_ready`;
    try {
        fs.unlinkSync(markerPath);
    } catch (err) {}

    // Clear other references
    masterPlaylist = null;
    selectedAudioTracks = null;
    selectedSubtitleTracks = null;
    currentVariant = null;

    console.log("Cleanup completed");
}
