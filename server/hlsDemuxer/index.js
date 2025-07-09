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
const BANDWIDTH_SMOOTHING_FACTOR = 0.38;
const BANDWIDTH_ADJUSTMENT_FACTOR = 0.8;

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
const preferredAudioLangs = config.languages;
const subtitleLanguage = config.subtitleLanguage;
const moduleIdentifier = config.moduleIdentifier;
let lastSegment = null;
let currentVariant = null;
let _currentVariant_ = null;
let estimatedBandwidth = 2000000;
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
        const response = await axios.get(_url);
        return HLS.parse(response.data);
    } catch (error) {
        console.error(`Error fetching playlist: ${error.message}`);
        return null;
    }
}

async function fetchSegmentList(stream) {
    if (!isVod) {
        stream.playlist = await fetchPlaylist(stream.url);

        if (!stream.playlist) {
            await new Promise((res) => setTimeout(res, 1000));
            return await fetchSegmentList(stream);
        }

        isVod = stream.playlist.segments.length > 30 ? true : false; // toggle vod flag if segments is > 30
    }
    if (!isVod) return stream.playlist;

    if (!stream.playlist) {
        await new Promise((res) => setTimeout(res, 1000));
        return await fetchSegmentList(stream);
    }

    if (stream.playlist.segments.length > 0) {
        const p = JSON.parse(JSON.stringify(stream.playlist));
        p.segments = p.segments.slice(
            stream.pointer,
            stream.pointer + stream.page
        );
        stream.pointer += stream.page;

        return p;
    }

    return stream.playlist;
}

/**
 * Selects the best video variant based on estimated bandwidth.
 * @returns {string|null} - The selected variant URI.
 */
async function selectBestVariant() {
    if (!masterPlaylist || !masterPlaylist.isMasterPlaylist) return;

    // find least bitrate
    const least = masterPlaylist.variants.reduce((prev, curr) => {
        return !prev || curr.bandwidth < prev.bandwidth ? curr : prev;
    });

    const bestVariant = masterPlaylist.variants.reduce((best, variant) => {
        return variant.bandwidth <=
            estimatedBandwidth * BANDWIDTH_ADJUSTMENT_FACTOR &&
            variant.bandwidth > best.bandwidth &&
            variant.resolution.height <= config.maxQuality
            ? variant
            : best;
    }, least);

    if (currentVariant !== bestVariant.uri) {
        console.log(
            `Switching to Variant: ${bestVariant.resolution?.height} @ ${
                bestVariant.bandwidth / 1000
            } Kbps`
        );
        currentVariant = bestVariant.uri;
        _currentVariant_ = bestVariant;
        // update vod segments if quality changes
        if (isVod) {
            streams[0].url = new URL(currentVariant, hlsUrl);
            streams[0].playlist = await fetchPlaylist(currentVariant);
        }
        return;
    }
    return;
}

/**
 * Selects the preferred audio tracks based on user preferences.
 * @returns {object} - Selected audio tracks.
 */
async function selectAudioTracks() {
    if (!masterPlaylist || !masterPlaylist.isMasterPlaylist) return;
    const selectedTracks = {};

    let count = 1;
    for (const track of _currentVariant_.audio) {
        if (
            preferredAudioLangs.length === 0 ||
            preferredAudioLangs.includes(track.language)
        ) {
            selectedTracks[track.language] = track;
            if (streams[count]) {
                streams[count].uri = new URL(track.uri, hlsUrl);
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
    if (!masterPlaylist || !masterPlaylist.isMasterPlaylist) return;
    const selectedTracks = {};

    for (const track of _currentVariant_.subtitles) {
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
        const response = await axios({
            url: segmentUrl,
            responseType: "stream",
        });

        const contentLength =
            parseInt(response.headers["content-length"], 10) || 0;

        const chunks = [];
        await new Promise((resolve, reject) => {
            response.data.on("data", (chunk) => chunks.push(chunk));
            response.data.on("end", () => {
                resolve();
            });
            response.data.on("error", reject);
        });

        const downloadEndTime = Date.now();

        const buffer = Buffer.concat(chunks);
        // Now pipe the buffer to the pipe stream
        await pipe.write(buffer);

        // Only calculate bandwidth for video segments and if content length is greater than 10000 bytes
        if (isVideo && contentLength > 10000) {
            const duration = (downloadEndTime - startTime) / 1000;
            if (duration > 0) {
                const bandwidth = (contentLength * 8) / duration;
                estimatedBandwidth =
                    estimatedBandwidth * BANDWIDTH_SMOOTHING_FACTOR +
                    bandwidth * (1 - BANDWIDTH_SMOOTHING_FACTOR);
                selectBestVariant();
            }
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
 * Continuously fetches and streams live HLS segments.
 * @param {string} playlistUrl - The URL of the media playlist.
 * @param {fs.WriteStream} pipe - The writable stream.
 * @param {boolean} [isVideo=false] - Whether the stream is video.
 */
async function streamLiveSegments(stream, index) {
    let playlist;
    let lastSeqNumber = 0;
    do {
        playlist = await fetchSegmentList(stream, index);

        // start halfway through the playlist if it's a live stream and we're just starting
        if (!isVod && lastSeqNumber === 0) {
            lastSeqNumber =
                playlist.segments[Math.floor(playlist.segments.length / 2)]
                    .mediaSequenceNumber;
        }
        playlist.segments =
            playlist.segments.filter(
                (s) => s.mediaSequenceNumber > lastSeqNumber
            ) || [];
        playlist.segments.length > 0 &&
            (lastSeqNumber =
                playlist.segments[playlist.segments.length - 1]
                    .mediaSequenceNumber);
        const map = playlist.source.match(/(?<=EXT-X-MAP:URI=\")(.*)(?=\")/gm);
        if (map)
            await fetchSegment(
                new URL(map[0], stream.url),
                stream.pipe,
                stream.isVideo
            );

        for (const segment of playlist.segments) {
            if (lastSegment && segment.uri === lastSegment) continue;
            lastSegment = segment.uri;
            const segmentUrl = new URL(segment.uri, stream.url).href;
            await fetchSegment(segmentUrl, stream.pipe, stream.isVideo);
        }
        await new Promise((res) => setTimeout(res, 1000));
    } while (!isVod || playlist.segments.length > 0);

    console.log(
        "EOF: " + stream.language
            ? stream.isSub
                ? "subtitle"
                : stream.language
            : "video"
    );
}

let streams = [];

/**
 * Initializes and starts video, audio, and subtitle streams.
 */
async function startStreams() {
    masterPlaylist = await fetchPlaylist(hlsUrl);
    selectBestVariant();
    selectedAudioTracks = await selectAudioTracks();
    selectedSubtitleTracks = await selectSubtitleTracks();
    const pipe = (moduleIdentifier ? moduleIdentifier + "_" : "") + `videoPipe`;
    const videoPipe = await createPipe(pipe);

    streams.push({
        index: 0,
        url: new URL(currentVariant, hlsUrl).href,
        pointer: 0,
        page: 3,
        isVideo: true,
        pipe: videoPipe,
        isVod: false,
        playlist: undefined,
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
        });
        count++;
    }
    streams.forEach(async (s, i) => {
        await streamLiveSegments(s, i);
        s.pipe.end();
    });
}

startStreams();

/**
 * removes and creates a new pipe
 */
async function createPipe(pipeName) {
    let pipe = `/tmp/${pipeName}`;
    try {
        await exec(`rm ${pipe}`);
    } catch (err) {}
    try {
        await exec(`mkfifo ${pipe}`);
    } catch (err) {}

    const _pipe = fs.createWriteStream(pipe, {
        flags: "a",
    });

    _pipe.on("error", (err) => {
        if (err.code === "EPIPE") {
            console.warn(`Warning: Broken pipe on ${pipe}, exiting...`);
            process.exit(0);
        } else {
            console.error("WriteStream Error:", err);
            process.exit(0);
        }
    });

    // consider moving this to hls player to spawn after gstreamer
    setTimeout(async () => {
        // set fifo size to 30M
        await exec(`echo 33554432 | sudo tee /proc/sys/fs/pipe-max-size`); // need to add the following line to the sudoers file: <user> ALL=(root) NOPASSWD: /bin/tee  /proc/sys/fs/pipe-max-size
        await exec(`${path.dirname(process.argv[1])}/setfifo ${pipe} 20000000`);
    }, 10000);

    return _pipe;
}

process.on("unhandledRejection", console.log);
