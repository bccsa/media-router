// GStreamer pipeline example using node-gst-1.0
import gi from '@girs/node-gst-1.0';

// Initialize GStreamer
gi.init([]);

interface PipelineConfig {
    name: string;
    duration?: number; // Duration in seconds
}

class SimpleGStreamerPipeline {
    private pipeline: gi.Pipeline | null = null;
    private bus: gi.Bus | null = null;
    private pipelineElements: gi.Element[] = [];

    constructor(private config: PipelineConfig) {}

    createPipeline(): boolean {
        try {
            // Create pipeline equivalent to: gst-launch-1.0 audiotestsrc ! fakesink
            console.log(`Creating GStreamer pipeline: ${this.config.name}`);

            // Create the pipeline
            this.pipeline = gi.Pipeline.new(this.config.name);
            if (!this.pipeline) {
                console.error('Failed to create pipeline');
                return false;
            }

            // Create elements
            const audioTestSrc = gi.ElementFactory.make('audiotestsrc', 'audio-source');
            const opusEnc = gi.ElementFactory.make('opusenc', 'opus-encoder');
            const opusRtpPay = gi.ElementFactory.make('rtpopuspay', 'opus-rtp-pay');
            const webRtcBin = gi.ElementFactory.make('webrtcbin', 'webrtc-bin');

            if (!audioTestSrc || !opusEnc || !opusRtpPay || !webRtcBin) {
                console.error('Failed to create elements');
                return false;
            }

            // Configure audiotestsrc (optional)
            audioTestSrc.setProperty('freq', 440); // 440 Hz tone
            audioTestSrc.setProperty('wave', 0); // Sine wave

            // Configure rtp payloader
            opusRtpPay.setProperty('pt', 111); // Payload type for RTP (e.g., 111 for dynamic payload type)

            // Add elements to pipeline
            this.pipeline.add(audioTestSrc);
            this.pipeline.add(opusEnc);
            this.pipeline.add(opusRtpPay);
            this.pipeline.add(webRtcBin);

            this.pipelineElements.push(audioTestSrc, opusEnc, opusRtpPay, webRtcBin);

            // Link elements
            if (
                !audioTestSrc.link(opusEnc) ||
                !opusEnc.link(opusRtpPay) ||
                !opusRtpPay.link(webRtcBin)
            ) {
                console.error('Failed to link elements');
                return false;
            }

            console.log('Pipeline created successfully');
            return true;
        } catch (error) {
            console.error('Error creating pipeline:', error);
            return false;
        }
    }

    start(): void {
        if (!this.pipeline) {
            console.error('Pipeline not created');
            return;
        }

        try {
            // Get the bus for message handling
            this.bus = this.pipeline.getBus();

            // Set pipeline to playing state
            const ret = this.pipeline.setState(gi.State.PLAYING);

            if (ret === gi.StateChangeReturn.FAILURE) {
                console.error('Failed to start pipeline');
                return;
            }

            console.log('Pipeline started - generating audio test signal');

            // Handle bus messages
            this.handleBusMessages();

            // Auto-stop after specified duration
            if (this.config.duration) {
                setTimeout(() => {
                    this.stop();
                }, this.config.duration * 1000);
            }

            // Get the webrtcbin element to set up signaling
            const webRtcBin = this.pipelineElements.find(el => el.getName() === 'webrtc-bin');
            console.log('WebRTC Bin:', webRtcBin);
            if (webRtcBin) {
                // Set up signaling for WebRTC (e.g., connect to a signaling server)
                webRtcBin.connect;
                webRtcBin.connect('on-negotiation-needed', data => {
                    console.log('Negotiation needed for WebRTC: ' + data);
                    // Here you would typically emit a signal or call a signaling server to exchange SDP offers/answers
                });
            }
        } catch (error) {
            console.error('Error starting pipeline:', error);
        }
    }

    private handleBusMessages(): void {
        if (!this.bus) return;

        // Poll for messages
        const messageHandler = () => {
            const msg = this.bus?.pop();
            if (msg) {
                switch (msg.type) {
                    case gi.MessageType.ERROR:
                        const [error, debug] = msg.parseError();
                        console.error(`Pipeline error: ${error.message}`);
                        if (debug) console.error(`Debug info: ${debug}`);
                        this.stop();
                        break;

                    case gi.MessageType.EOS:
                        console.log('End of stream reached');
                        this.stop();
                        break;

                    case gi.MessageType.STATE_CHANGED:
                        if (msg.src === this.pipeline) {
                            const [oldState, newState] = msg.parseStateChanged();
                            console.log(
                                `Pipeline state changed: ${gi.Element.stateGetName(oldState)} -> ${gi.Element.stateGetName(newState)}`
                            );
                        }
                        break;
                }
            }

            // Continue polling if pipeline is running
            if (this.pipeline?.currentState === gi.State.PLAYING) {
                setTimeout(messageHandler, 100);
            }
        };

        messageHandler();
    }

    stop(): void {
        if (!this.pipeline) return;

        try {
            console.log('Stopping pipeline...');

            // Set pipeline to null state
            this.pipeline.setState(gi.State.NULL);

            console.log('Pipeline stopped');

            // Exit the application
            process.exit(0);
        } catch (error) {
            console.error('Error stopping pipeline:', error);
        }
    }
}

function main(): void {
    console.log('GStreamer TypeScript Pipeline Demo');
    console.log('===================================');

    try {
        // Create and configure pipeline
        const pipelineConfig: PipelineConfig = {
            name: 'audio-test-pipeline',
            //   duration: 5 // Run for 5 seconds
        };

        const pipeline = new SimpleGStreamerPipeline(pipelineConfig);

        // Create the pipeline
        if (!pipeline.createPipeline()) {
            console.error('Failed to create pipeline');
            process.exit(1);
        }

        // Start the pipeline
        pipeline.start();

        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nReceived SIGINT, stopping pipeline...');
            pipeline.stop();
        });
    } catch (error) {
        console.error('Application error:', error);
        process.exit(1);
    }
}

// Run the main function
main();
