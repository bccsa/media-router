const _paNullSinkBase = require('./_paNullSinkBase');
const SrtBase = require('./SrtBase');
const path = require('path');
const { Classes } = require('../modular-dm');

class SrtVideoEncoder extends Classes(_paNullSinkBase, SrtBase) {
    constructor() {
        super();
        // capture
        this.video_device = "/dev/video0";
        this.capture_format = "raw";
        this.deinterlace = false;
        // encoder
        this.encoder = "v4l2h264enc"; // options (software: openh264enc, hardware: v4l2h264enc)
        this.video_bitrate = "2M";
        this.video_gop = 30;            // amount of frame interval before a new full frame is sent  
        this.video_width = 1280;
        this.video_height = 720;
        this.video_framerate = 30;
        this.audio_bitrate = 196;
        this._srtElementName = "srtserversink";
    }

    Init() {
        super.Init();

        // Start external processes when the underlying pipe-source is ready (from extended class)
        this.on('ready', ready => {
            if (ready) {
                let _valid = true;
                this._parent._log('INFO', `${this._controlName} (${this.displayName}): Starting srt video encoder (gstreamer)`);

                // ------------ Capture ------------ //
                // capture format
                let gstVideoDecode = "";
                if (this.capture_format == "mjpeg") { gstVideoDecode = `jpegdec ! ` };

                // deinterlace
                let gstDeinterlace = "";
                if (this.deinterlace) { gstDeinterlace = `deinterlace mode=1 locking=2 ! ` };

                // ------------ Validation ------------ //
                // video bitrate
                let vb = parseInt(this.video_bitrate.toString().replace('k', '000').replace('M', '000000'));
                if (typeof vb != "number") { 
                    _valid = false;
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Invalid video bitrate, <b>pipeline NOT started</b>.`);
                }

                // ------------ Encoding ------------ //
                let gstEncoder = "";
                if (this.encoder == "v4l2h264enc") {
                    gstEncoder = `v4l2h264enc extra-controls="encode,video_bitrate=${vb},video_bitrate_mode=0,h264_level=13,repeat_sequence_header=1,video_gop_size=${this.video_gop},h264_profile=0" ! video/x-h264,level=(string)4.2 ! `; // h264level 4.2 to support 50p (https://en.wikipedia.org/wiki/Advanced_Video_Coding)
                } else if (this.encoder == "openh264enc") {
                    gstEncoder = `openh264enc multi-thread=4 bitrate=2048000 min-force-key-unit-interval=5000000000 rate-control=off slice-mode=5 ! video/x-h264,profile=baseline ! `;
                } else {
                    _valid = false;
                    this._parent._log('FATAL', `${this._controlName} (${this.displayName}): Invalid encoder selected, <b>pipeline NOT started</b>.`);
                }

                // ------------ Pipeline ------------ //
                // video device
                let _pipeline = `v4l2src device=${this.video_device} do-timestamp=true ! ` +
                // capture format
                gstVideoDecode +
                // deinterlace
                gstDeinterlace + 
                `queue leaky=2 max-size-time=20000000 flush-on-eos=true ! videoconvert ! ` + 
                // video frame rate conversion
                `videorate ! video/x-raw,framerate=${this.video_framerate}/1 ! ` +
                // video scale conversion
                `videoscale n-threads=4 ! video/x-raw,width=${this.video_width},height=${this.video_height} ! ` +
                // h264 encoding
                gstEncoder +
                // audio device
                `mux. pulsesrc device="${this.source}" ! ` +
                // audio caps
                `audio/x-raw,rate=${this.sampleRate},format=S${this.bitDepth}LE,channels=${this.channels} ! ` +
                // audio convert and resample 
                `queue leaky=2 max-size-time=20000000 flush-on-eos=true ! audioconvert ! audioresample ! ` +
                // audio encoding 
                `voaacenc bitrate=${this.audio_bitrate * 1000} ! aacparse ! ` +
                // mpegts mux
                `mpegtsmux latency=1 name=mux ! queue leaky=2 max-size-time=10000000 flush-on-eos=true ! ` +
                // srt sink
                `srtserversink name=${this._srtElementName} sync=false wait-for-connection=false uri="${this.uri()}"`;

                // ------------ start srt encoder ------------ //
                if (_valid)
                this._parent.PaCmdQueue(() => { 
                    this._start_gst(`${path.dirname(process.argv[1])}/child_processes/SrtVideoEncoder_child.js`, [
                        _pipeline,
                        this._srtElementName
                    ]);
                });
            }
        });

        // Stop external processes when the control is stopped (through setting this.run to false)
        this.on('run', run => {
            if (!run) {
                this._stop_gst();
            }
        });
    }
}

module.exports = SrtVideoEncoder;