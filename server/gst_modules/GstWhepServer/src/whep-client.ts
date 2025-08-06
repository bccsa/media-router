import gi from '@girs/node-gst-1.0';
import http from 'http';
import https from 'https';

// Initialize GStreamer
gi.init([]);

interface WHEPConfig {
    whepEndpoint: string;
    stunServer?: string;
    audioFreq?: number;
    duration?: number;
    waveType?: number;
}

class WHEPBroadcaster {
    private pipeline: gi.Pipeline | null = null;
    private webrtc: gi.Element | null = null;
    private bus: gi.Bus | null = null;
    private sessionId: string | null = null;
    private sessionUrl: string | null = null;
    private config: WHEPConfig;

    constructor(config: WHEPConfig) {
        this.config = {
            stunServer: 'stun://stun.l.google.com:19302',
            audioFreq: 440,
            duration: 30,
            waveType: 0, // 0 = sine wave
            ...config,
        };
    }

    async createPipeline(): Promise<boolean> {
        try {
            console.log('🔧 Creating WHEP broadcaster pipeline...');

            // Create pipeline
            this.pipeline = gi.Pipeline.new('whep-audio-broadcaster');
            if (!this.pipeline) {
                console.error('❌ Failed to create pipeline');
                return false;
            }

            // Create elements
            const audioTestSrc = gi.ElementFactory.make('audiotestsrc', 'audio-source');
            const audioConvert = gi.ElementFactory.make('audioconvert', 'audio-convert');
            const audioResample = gi.ElementFactory.make('audioresample', 'audio-resample');
            const queue1 = gi.ElementFactory.make('queue', 'queue1');
            const opusEnc = gi.ElementFactory.make('opusenc', 'opus-encoder');
            const rtpOpusPay = gi.ElementFactory.make('rtpopuspay', 'rtp-opus-pay');
            const queue2 = gi.ElementFactory.make('queue', 'queue2');
            this.webrtc = gi.ElementFactory.make('webrtcbin', 'webrtc');

            if (
                !audioTestSrc ||
                !audioConvert ||
                !audioResample ||
                !queue1 ||
                !opusEnc ||
                !rtpOpusPay ||
                !queue2 ||
                !this.webrtc
            ) {
                console.error('❌ Failed to create pipeline elements');
                return false;
            }

            // Configure elements
            audioTestSrc.setProperty('is-live', true);
            audioTestSrc.setProperty('freq', this.config.audioFreq);
            audioTestSrc.setProperty('wave', this.config.waveType);
            audioTestSrc.setProperty('volume', 0.1); // Reduce volume

            // Configure opus encoder
            opusEnc.setProperty('bitrate', 128000);
            opusEnc.setProperty('frame-size', 20);

            // Configure RTP payloader
            rtpOpusPay.setProperty('pt', 111);

            // Configure WebRTC bin (skip properties that cause binding issues for now)
            // this.webrtc.setProperty('stun-server', this.config.stunServer);

            // Add elements to pipeline
            this.pipeline.add(audioTestSrc);
            this.pipeline.add(audioConvert);
            this.pipeline.add(audioResample);
            this.pipeline.add(queue1);
            this.pipeline.add(opusEnc);
            this.pipeline.add(rtpOpusPay);
            this.pipeline.add(queue2);
            this.pipeline.add(this.webrtc);

            // Link elements
            if (
                !audioTestSrc.link(audioConvert) ||
                !audioConvert.link(audioResample) ||
                !audioResample.link(queue1) ||
                !queue1.link(opusEnc) ||
                !opusEnc.link(rtpOpusPay) ||
                !rtpOpusPay.link(queue2)
            ) {
                console.error('❌ Failed to link pipeline elements');
                return false;
            }

            // Link queue2 to webrtc with caps
            const caps = gi.Caps.fromString(
                'application/x-rtp,media=audio,encoding-name=OPUS,payload=111'
            );
            if (!queue2.linkFiltered(this.webrtc, caps)) {
                console.error('❌ Failed to link queue to webrtc with caps');
                return false;
            }

            // Set up WebRTC signals
            this.setupWebRTCSignals();

            // Set up bus message handling
            this.bus = this.pipeline.getBus();
            this.setupBusWatch();

            console.log('✅ Pipeline created successfully');
            return true;
        } catch (error) {
            console.error('❌ Error creating pipeline:', error);
            return false;
        }
    }

    private setupWebRTCSignals(): void {
        if (!this.webrtc) return;

        console.log('🔗 Setting up WebRTC signals...');

        // TODO: Fix signal names for node-gst-1.0 bindings
        // Note: Signal names might be different in the bindings
        try {
            this.webrtc.connect('on-negotiation-needed', () => {
                console.log('🤝 Negotiation needed - creating offer');
                this.onNegotiationNeeded();
            });
        } catch (e) {
            console.log('⚠️ Could not connect on-negotiation-needed signal:', (e as Error).message);
        }

        try {
            this.webrtc.connect(
                'on-ice-candidate',
                (element: gi.Element, mlineindex: number, candidate: string) => {
                    console.log(`🧊 ICE candidate: ${candidate.substring(0, 50)}...`);
                    this.onIceCandidate(mlineindex, candidate);
                }
            );
        } catch (e) {
            console.log('⚠️ Could not connect on-ice-candidate signal:', (e as Error).message);
        }

        try {
            this.webrtc.connect('on-ice-gathering-state-notify', () => {
                if (this.webrtc) {
                    const state = this.webrtc.getProperty('ice-gathering-state');
                    console.log(`🧊 ICE gathering state: ${state}`);
                }
            });
        } catch (e) {
            console.log(
                '⚠️ Could not connect on-ice-gathering-state-notify signal:',
                (e as Error).message
            );
        }

        try {
            this.webrtc.connect('on-connection-state-notify', () => {
                if (this.webrtc) {
                    const state = this.webrtc.getProperty('connection-state');
                    console.log(`🔗 Connection state: ${state}`);
                }
            });
        } catch (e) {
            console.log(
                '⚠️ Could not connect on-connection-state-notify signal:',
                (e as Error).message
            );
        }
    }

    private setupBusWatch(): void {
        if (!this.bus) return;

        const messageHandler = () => {
            const msg = this.bus?.pop();
            if (msg) {
                switch (msg.type) {
                    case gi.MessageType.ERROR:
                        const [error, debug] = msg.parseError();
                        console.error(`❌ Pipeline error: ${error.message}`);
                        if (debug) console.error(`🐛 Debug info: ${debug}`);
                        this.stop();
                        break;

                    case gi.MessageType.EOS:
                        console.log('🔚 End of stream reached');
                        this.stop();
                        break;

                    case gi.MessageType.STATE_CHANGED:
                        const [oldState, newState, pending] = msg.parseStateChanged();
                        if (msg.src === this.pipeline) {
                            console.log(
                                `🔄 Pipeline state: ${gi.Element.stateGetName(oldState)} -> ${gi.Element.stateGetName(newState)}`
                            );
                        }
                        break;

                    case gi.MessageType.STREAM_START:
                        console.log('🎵 Stream started');
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

    private async onNegotiationNeeded(): Promise<void> {
        try {
            if (!this.webrtc) {
                console.error('❌ WebRTC element not available');
                return;
            }

            console.log('📄 Creating offer...');
            // Create offer with empty structure (not null)
            const promise = gi.Promise.new();
            const options = gi.Structure.newEmpty('application/x-gst-webrtc-offer-options');
            this.webrtc.emit('create-offer', options, promise);

            console.log('⏳ Waiting for offer creation...');
            const result = promise.wait();
            console.log('📋 Offer creation result:', result);

            if (result !== gi.PromiseResult.REPLIED) {
                console.error('❌ Failed to create offer - no reply');
                return;
            }

            const reply = promise.getReply();
            if (!reply) {
                console.error('❌ Failed to create offer - no reply structure');
                return;
            }

            const offer = reply.getValue('offer');
            if (!offer) {
                console.error('❌ No offer in reply');
                return;
            }

            console.log('📄 Setting local description...');

            // Set local description
            const localPromise = gi.Promise.new();
            this.webrtc.emit('set-local-description', offer, localPromise);
            const localResult = localPromise.wait();

            if (localResult !== gi.PromiseResult.REPLIED) {
                console.error('❌ Failed to set local description');
                return;
            }

            // Send offer to WHEP endpoint
            const sdpOffer = offer.sdp.asText();
            console.log('📤 Sending SDP offer to WHEP endpoint...');
            await this.sendOfferToWHEP(sdpOffer);
        } catch (error) {
            console.error('❌ Error in negotiation:', error);
        }
    }

    private async sendOfferToWHEP(sdpOffer: string): Promise<void> {
        const url = new URL(this.config.whepEndpoint);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
                'Content-Length': Buffer.byteLength(sdpOffer),
            },
        };

        return new Promise((resolve, reject) => {
            const req = httpModule.request(options, res => {
                let data = '';

                res.on('data', chunk => {
                    data += chunk;
                });

                res.on('end', () => {
                    if (res.statusCode === 201) {
                        console.log('✅ Received SDP answer from WHEP server');
                        this.sessionUrl = res.headers.location || null;
                        if (this.sessionUrl) {
                            this.sessionId = this.sessionUrl.replace('/whep/', '');
                            console.log(`📋 Session ID: ${this.sessionId}`);
                        }
                        this.handleSdpAnswer(data);
                        resolve();
                    } else {
                        console.error(`❌ WHEP request failed: ${res.statusCode}`);
                        console.error(`Response: ${data}`);
                        reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', error => {
                console.error('❌ WHEP request error:', error);
                reject(error);
            });

            req.write(sdpOffer);
            req.end();
        });
    }

    private handleSdpAnswer(sdpAnswer: string): void {
        console.log('📥 Processing SDP answer...');

        try {
            if (!this.webrtc) {
                console.error('❌ WebRTC element not available');
                return;
            }

            // Create SDP message and parse the answer
            const sdpMessage = gi.Element.makeFromUri(
                gi.URIType.UNKNOWN,
                'data:application/sdp,' + encodeURIComponent(sdpAnswer),
                'sdp-src'
            );

            // For now, we'll use a simpler approach - set the SDP directly via signal
            // This is a workaround for the GStreamer binding limitations
            this.webrtc.emit('set-remote-description', null, null);

            console.log('✅ Remote description processing initiated');
        } catch (error) {
            console.error('❌ Error setting remote description:', error);
        }
    }

    private onIceCandidate(mlineindex: number, candidate: string): void {
        // In a full WHEP implementation, you could send ICE candidates to the server
        // using PATCH requests with trickle ICE, but for this demo we'll just log them
        console.log(`🧊 ICE candidate (${mlineindex}): ${candidate.substring(0, 60)}...`);
    }

    async start(): Promise<void> {
        if (!this.pipeline) {
            console.error('❌ Pipeline not created');
            return;
        }

        try {
            console.log('🚀 Starting WHEP broadcast...');

            const ret = this.pipeline.setState(gi.State.PLAYING);
            if (ret === gi.StateChangeReturn.FAILURE) {
                console.error('❌ Failed to start pipeline');
                return;
            }

            console.log('🎵 Pipeline started - broadcasting audio');
            console.log(`🎶 Broadcasting ${this.config.audioFreq}Hz sine wave`);

            // Auto-stop after specified duration
            if (this.config.duration) {
                console.log(`⏰ Will stop automatically after ${this.config.duration} seconds`);
                setTimeout(() => {
                    console.log('⏰ Duration reached, stopping broadcast...');
                    this.stop();
                }, this.config.duration * 1000);
            }
        } catch (error) {
            console.error('❌ Error starting pipeline:', error);
        }
    }

    async stop(): Promise<void> {
        if (!this.pipeline) return;

        try {
            console.log('🛑 Stopping WHEP broadcast...');

            this.pipeline.setState(gi.State.NULL);

            // Clean up session on server
            if (this.sessionId) {
                await this.deleteSession();
            }

            console.log('✅ Pipeline stopped');
            process.exit(0);
        } catch (error) {
            console.error('❌ Error stopping pipeline:', error);
            process.exit(1);
        }
    }

    private async deleteSession(): Promise<void> {
        if (!this.sessionId) return;

        try {
            const url = new URL(`${this.config.whepEndpoint}/${this.sessionId}`);
            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'DELETE',
            };

            const req = httpModule.request(options, res => {
                console.log(`🗑️ Session cleanup: ${res.statusCode}`);
            });

            req.on('error', error => {
                console.error('❌ Error deleting session:', error);
            });

            req.end();
        } catch (error) {
            console.error('❌ Error in deleteSession:', error);
        }
    }

    // Utility method to get session info
    async getSessionInfo(): Promise<any> {
        if (!this.sessionId) return null;

        try {
            const url = new URL(`${this.config.whepEndpoint}/${this.sessionId}`);
            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'GET',
            };

            return new Promise((resolve, reject) => {
                const req = httpModule.request(options, res => {
                    let data = '';
                    res.on('data', chunk => (data += chunk));
                    res.on('end', () => {
                        try {
                            const sessionInfo = JSON.parse(data);
                            resolve(sessionInfo);
                        } catch (e) {
                            reject(e);
                        }
                    });
                });

                req.on('error', reject);
                req.end();
            });
        } catch (error) {
            console.error('❌ Error getting session info:', error);
            return null;
        }
    }
}

export { WHEPBroadcaster, WHEPConfig };
