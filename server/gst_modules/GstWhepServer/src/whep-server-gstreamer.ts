import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import Gst from '@girs/node-gst-1.0';
import GstWebRTC from '@girs/node-gstwebrtc-1.0';
import path from 'path';
import {
    gstCreateAnswer,
    gstSetIceCandidate,
    gstSetLocalDescription,
    gstSetRemoteDescription,
    sdpMudgeIceCandidates,
    filterSdp
} from './util';

// Initialize GStreamer//
Gst.init([]);

const timeout = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface WHEPSession {
    id: string;
    pipeline: Gst.Pipeline;
    webrtc: Gst.Element;
    createdAt: Date;
    state: 'connecting' | 'connected' | 'failed' | 'closed';
    sdpOffer?: string; // Store SDP offer for later processing
}

type WhepServerSettings = {
    pulseDevice: string; // PulseAudio source device
    port?: number; // Port for the WHEP server
    opusFec?: boolean; // Enable Opus FEC
    opusFecPacketLoss?: number; // Opus FEC packet loss percentage
    opusComplexity?: number; // Opus complexity (0-10)
    opusBitrate?: number; // Opus bitrate in bps
    opusFrameSize?: number; // Opus frame size in ms
    rtpRed?: boolean; // Enable RTP RED
    rtpRedDistance?: number; // RTP RED distance
};

class WHEPGStreamerServer {
    private app: express.Application;
    private sessions: Map<string, WHEPSession> = new Map();
    private audioFreq: number = 440;
    private waveType: number = 0; // sine wave
    private settings: WhepServerSettings;

    constructor(settings: WhepServerSettings) {
        this.settings = settings;
        this.app = express();
        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        this.app.use(
            cors({
                origin: '*',
                methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
                allowedHeaders: ['Content-Type', 'Authorization', 'If-Match'],
            })
        );

        this.app.use(express.text({ type: 'application/sdp' }));
        this.app.use(express.json());

        // Serve static files from public directory
        this.app.use(express.static(path.join(__dirname, '../public')));
    }

    private setupRoutes(): void {
        // Root route - serve client page
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, '../public/whep-client.html'));
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                sessions: this.sessions.size,
                timestamp: new Date().toISOString(),
            });
        });

        // List active sessions
        this.app.get('/sessions', (req, res) => {
            const sessionList = Array.from(this.sessions.entries()).map(([id, session]) => ({
                id,
                state: session.state,
                createdAt: session.createdAt,
            }));
            res.json({ sessions: sessionList });
        });

        // WHEP endpoint - create new session
        this.app.post('/whep', async (req, res) => {
            try {
                console.log('📥 Received WHEP request');

                if (req.headers['content-type'] !== 'application/sdp') {
                    return res.status(400).json({
                        error: 'Content-Type must be application/sdp',
                    });
                }

                const sdpOffer = filterSdp(req.body);
                if (!sdpOffer || typeof sdpOffer !== 'string') {
                    return res.status(400).json({ error: 'Invalid SDP offer' });
                }

                console.log('📄 SDP Offer received, creating session...');
                const session = await this.createSession(sdpOffer);

                if (!session) {
                    return res.status(500).json({ error: 'Failed to create session' });
                }

                // Generate SDP answer
                const sdpAnswer = await this.generateAnswer(session);
                if (!sdpAnswer) {
                    this.cleanupSession(session.id);
                    return res.status(500).json({ error: 'Failed to generate SDP answer' });
                }

                res.status(201)
                    .header('Content-Type', 'application/sdp')
                    .header('Location', `/whep/${session.id}`)
                    .send(sdpAnswer);

                console.log(`✅ Session ${session.id} created successfully`);
            } catch (error) {
                console.error('❌ Error handling WHEP request:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // Get session info
        this.app.get('/whep/:sessionId', (req, res) => {
            const session = this.sessions.get(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }

            res.json({
                id: session.id,
                state: session.state,
                createdAt: session.createdAt,
            });
        });

        // Delete session
        this.app.delete('/whep/:sessionId', (req, res) => {
            const sessionId = req.params.sessionId;
            const session = this.sessions.get(sessionId);

            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }

            this.cleanupSession(sessionId);
            res.status(204).send();
            console.log(`🗑️ Session ${sessionId} deleted`);
        });

        // Handle ICE candidates (PATCH)
        this.app.patch('/whep/:sessionId', (req, res) => {
            const session = this.sessions.get(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ error: 'Session not found' });
            }

            // Handle ICE candidate
            // TODO: This is untested, and in the testing environment is seems as if the client does not send the ICE candidates (RTCPeerConnection.onicecandidate is not triggered in the browser).
            if (req.headers['content-type'] === 'application/trickle-ice-sdpfrag') {
                console.log('🧊 Received ICE candidate');

                gstSetIceCandidate(session.webrtc, 0, req.body);
                res.status(204).send();
            } else {
                res.status(400).json({ error: 'Unsupported content type' });
            }
        });
    }

    private async createSession(sdpOffer: string): Promise<WHEPSession | null> {
        try {
            const sessionId = uuidv4();
            console.log(`🔧 Creating GStreamer pipeline for session ${sessionId}`);

            // Create pipeline
            const pipeline = Gst.Pipeline.new(`whep-session-${sessionId}`);
            if (!pipeline) {
                console.error('❌ Failed to create pipeline');
                return null;
            }

            // Create elements
            const audioTestSrc = Gst.ElementFactory.make('pulsesrc', 'audio-source');
            // const audioTestSrc = Gst.ElementFactory.make('audiotestsrc', 'audio-source');
            const audioConvert = Gst.ElementFactory.make('audioconvert', 'audio-convert');
            const audioResample = Gst.ElementFactory.make('audioresample', 'audio-resample');
            const queue1 = Gst.ElementFactory.make('queue', 'queue1');
            const opusEnc = Gst.ElementFactory.make('opusenc', 'opus-encoder');
            const rtpOpusPay = Gst.ElementFactory.make('rtpopuspay', 'rtp-opus-pay');
            const rtpUlpFecEnc = Gst.ElementFactory.make('rtpulpfecenc', 'rtp-ulpfec-encoder');
            // const identifier = Gst.ElementFactory.make('identity', 'identity');
            const queue2 = Gst.ElementFactory.make('queue', 'queue2');
            const webrtc = Gst.ElementFactory.make('webrtcbin', 'webrtc');

            if (
                !audioTestSrc ||
                !audioConvert ||
                !audioResample ||
                !queue1 ||
                !opusEnc ||
                !rtpOpusPay ||
                !rtpUlpFecEnc ||
                !queue2 ||
                !webrtc
            ) {
                console.error('❌ Failed to create pipeline elements');
                return null;
            }

            // Configure elements
            // audioTestSrc.setProperty('is-live', true);
            // audioTestSrc.setProperty('freq', this.audioFreq);
            // audioTestSrc.setProperty('wave', this.waveType);
            // audioTestSrc.setProperty('volume', 0.3);
            audioTestSrc.setProperty('device', this.settings.pulseDevice || 'default');

            // Configure opus encoder
            opusEnc.setProperty('bitrate', this.settings.opusBitrate || 64000);
            opusEnc.setProperty('frame-size', this.settings.opusFrameSize || 20);
            opusEnc.setProperty('inband-fec', this.settings.opusFec || false);
            opusEnc.setProperty('packet-loss-percentage', this.settings.opusFecPacketLoss || 0);

            // Configure RTP payloader
            rtpOpusPay.setProperty('pt', 111);

            // Configure ULPFEC encoder
            rtpUlpFecEnc.setProperty('pt', 122);
            rtpUlpFecEnc.setProperty('percentage', 100);

            // Add elements to pipeline
            pipeline.add(audioTestSrc);
            pipeline.add(audioConvert);
            pipeline.add(audioResample);
            pipeline.add(queue1);
            pipeline.add(opusEnc);
            pipeline.add(rtpOpusPay);
            pipeline.add(rtpUlpFecEnc);
            // pipeline.add(identifier);
            pipeline.add(queue2);
            pipeline.add(webrtc);

            webrtc.on('on-new-transceiver', (transceiver: GstWebRTC.WebRTCRTPTransceiver) => {
                transceiver.direction = GstWebRTC.WebRTCRTPTransceiverDirection.SENDONLY;
                transceiver.setProperty('fec-type', GstWebRTC.WebRTCFECType.ULP_RED);
                transceiver.setProperty('do-nack', true);
            });

            // Link elements
            if (
                !audioTestSrc.link(audioConvert) ||
                !audioConvert.link(audioResample) ||
                !audioResample.link(queue1) ||
                !queue1.link(opusEnc) ||
                !opusEnc.link(rtpOpusPay) ||
                !rtpOpusPay.link(rtpUlpFecEnc) ||
                !rtpUlpFecEnc.link(queue2)
            ) {
                console.error('❌ Failed to link pipeline elements');
                return null;
            }

            // Link queue2 to webrtc with caps
            const caps = Gst.Caps.fromString(
                // 'application/x-rtp,media=audio,encoding-name=OPUS,payload=111'
                'application/x-rtp,media=audio,encoding-name=RED,clock-rate=48000,payload=63'
            );
            // if (!queue2.linkFiltered(webrtc, caps)) {
            //     console.error('❌ Failed to link queue to webrtc with caps');
            //     return null;
            // }
            if (!queue2.link(webrtc)) {
                console.error('❌ Failed to link queue to webrtc');
                return null;
            }

            const session: WHEPSession = {
                id: sessionId,
                pipeline,
                webrtc,
                createdAt: new Date(),
                state: 'connecting',
            };

            // Store the SDP offer for later processing
            session.sdpOffer = sdpOffer;

            // Set the server ice candidates for the webrtc element.
            // This is needed as per WHEP server spec:
            // "The WHEP Endpoint SHALL gather all the ICE candidates for the Media Server
            // before responding to the client request and the SDP answer SHALL contain the
            // full list of ICE candidates of the Media Server"
            // (see https://www.ietf.org/archive/id/draft-murillo-whep-01.html)

            // Ivan Note: This is actually adding the client's ICE candidates, so it is not achieving what we want...
            // It seems as if the only way to add candidates is to mundge the SDP answer.
            // for (let i = 0; i < this.serverIceCandidates.length; i++) {
            //     setIceCandidate(webrtc, i, this.serverIceCandidates[i]);
            // }

            // Setup WebRTC signals
            this.setupWebRTCSignals(session);

            // Setup bus message handling
            this.setupBusWatch(session);

            this.sessions.set(sessionId, session);
            console.log(`✅ Session ${sessionId} created`);

            return session;
        } catch (error) {
            console.error('❌ Error creating session:', error);
            return null;
        }
    }

    private setupWebRTCSignals(session: WHEPSession): void {
        try {
            // Handle connection state changes
            session.webrtc.connect('notify::connection-state', () => {
                try {
                    const state = session.webrtc.getProperty('connection-state');
                    console.log(`🔗 Session ${session.id} - Connection state: ${state}`);

                    // Update session state based on WebRTC state
                    if (state === 'connected') {
                        session.state = 'connected';
                        console.log(
                            `✅ Session ${session.id} - Client connected and receiving audio`
                        );
                    } else if (state === 'failed' || state === 'closed') {
                        session.state = 'failed';
                        console.log(`❌ Session ${session.id} - Connection failed/closed`);
                        setTimeout(() => this.cleanupSession(session.id), 5000);
                    }
                } catch (error) {
                    console.log(
                        `⚠️ Error handling connection state for session ${session.id}:`,
                        error
                    );
                }
            });

            // Handle ICE connection state
            session.webrtc.connect('notify::ice-connection-state', () => {
                try {
                    const iceState = session.webrtc.getProperty('ice-connection-state');
                    console.log(`🧊 Session ${session.id} - ICE connection state: ${iceState}`);
                } catch (error) {
                    console.log(`⚠️ Error handling ICE state for session ${session.id}:`, error);
                }
            });
        } catch (e) {
            console.log('⚠️ Could not connect connection state signals:', (e as Error).message);
        }
    }

    private setupBusWatch(session: WHEPSession): void {
        const bus = session.pipeline.getBus();
        if (!bus) return;

        const messageHandler = () => {
            const msg = bus.pop();
            if (msg) {
                switch (msg.type) {
                    case Gst.MessageType.ERROR:
                        const [error, debug] = msg.parseError();
                        console.error(`❌ Session ${session.id} error: ${error.message}`);
                        if (debug) console.error(`🐛 Debug: ${debug}`);
                        session.state = 'failed';
                        this.cleanupSession(session.id);
                        break;

                    case Gst.MessageType.EOS:
                        console.log(`🔚 Session ${session.id} - End of stream`);
                        this.cleanupSession(session.id);
                        break;

                    case Gst.MessageType.STATE_CHANGED:
                        const [oldState, newState, pending] = msg.parseStateChanged();
                        if (msg.src === session.pipeline) {
                            console.log(
                                `🔄 Session ${
                                    session.id
                                } - Pipeline state: ${Gst.Element.stateGetName(
                                    oldState
                                )} -> ${Gst.Element.stateGetName(newState)}`
                            );
                        }
                        break;
                }
            }

            // Continue polling if session exists and pipeline is active
            if (this.sessions.has(session.id) && session.pipeline.currentState !== Gst.State.NULL) {
                setTimeout(messageHandler, 100);
            }
        };

        messageHandler();
    }

    // private async waitForIceGathering(session: WHEPSession): Promise<void> {
    //     return new Promise<void>((resolve, reject) => {
    //         let timeoutId: NodeJS.Timeout;

    //         const checkGatheringState = () => {
    //             try {
    //                 const gatheringState = session.webrtc.getProperty('ice-gathering-state');
    //                 console.log(`🧊 ICE gathering state: ${gatheringState}`);

    //                 if (gatheringState === 'complete') {
    //                     if (timeoutId) clearTimeout(timeoutId);
    //                     resolve();
    //                 } else {
    //                     // Keep checking
    //                     setTimeout(checkGatheringState, 100);
    //                 }
    //             } catch (error) {
    //                 if (timeoutId) clearTimeout(timeoutId);
    //                 reject(error);
    //             }
    //         };

    //         // Set timeout
    //         timeoutId = setTimeout(() => {
    //             reject(new Error('ICE gathering timeout'));
    //         }, 10000);

    //         checkGatheringState();
    //     });
    // }

    private async generateAnswer(session: WHEPSession): Promise<string | null> {
        try {
            console.log(`📝 Generating SDP answer for session ${session.id}`);

            const sdpOffer = (session as any).sdpOffer;
            if (!sdpOffer) {
                console.error('❌ No SDP offer stored');
                return null;
            }

            console.log('📥 Processing SDP offer and generating answer...');

            // Use a promise-based approach since the GStreamer bindings have limitations
            return new Promise<string>((resolve, reject) => {
                let answerReceived = false;
                let timeoutId: NodeJS.Timeout;

                // Handle the answer creation
                const createAnswer = async () => {
                    if (answerReceived) return;

                    console.log('🤝 Creating WebRTC answer...');

                    const iceCandidates: string[] = [];
                    session.webrtc.connect('on-ice-candidate', (num, candidate: string) => {
                        iceCandidates.push(candidate);
                    });

                    await gstSetRemoteDescription(session.webrtc, sdpOffer);
                    const answer = await gstCreateAnswer(session.webrtc);
                    if (!answer) {
                        console.error('❌ Failed to create answer');
                        reject(new Error('Failed to create answer'));
                        return;
                    }
                    answerReceived = true;
                    gstSetLocalDescription(session.webrtc, answer);

                    // Wait for the candidates to be collected
                    // TODO: We need a better way to get the candidates without using a timer
                    await timeout(3000);

                    let rtpredenc;
                    const _bin_webrtc = session.webrtc as Gst.Bin;
                    const _bin_rtp = _bin_webrtc.getChildByIndex(0) as Gst.Bin;
                    if (_bin_rtp) rtpredenc = _bin_rtp.getChildByIndex(0);
                    else console.log('❌ Unable to set RED distance due to rtpbin not found');
                    if (rtpredenc) rtpredenc.setProperty('distance', 2);
                    if (rtpredenc) rtpredenc.setProperty('allow-no-red-blocks', false);
                    else console.log('❌ Unable to set RED distance due to rtpredenc0 not found');

                    const mudgedSddWidthCandidates = sdpMudgeIceCandidates(
                        answer.sdp.asText(),
                        iceCandidates
                    );
                    // const mudgedSdpWithRed = sdpMudgeAudioRedEnc(mudgedSddWidthCandidates);
                    resolve(mudgedSddWidthCandidates);
                    return;
                };

                // Parse the offer for validation
                const offerLines = sdpOffer.split('\n');
                let hasAudio = false;

                for (const line of offerLines) {
                    if (line.startsWith('m=audio')) {
                        hasAudio = true;
                        break;
                    }
                }

                if (!hasAudio) {
                    reject(new Error('No audio media in SDP offer'));
                    return;
                }

                // Start the pipeline first
                console.log('🚀 Starting pipeline...');
                const ret = session.pipeline.setState(Gst.State.PLAYING);
                if (ret === Gst.StateChangeReturn.FAILURE) {
                    reject(new Error('Failed to start pipeline'));
                    return;
                }

                // Try to create answer after a short delay
                setTimeout(() => {
                    if (!answerReceived) {
                        createAnswer();
                    }
                }, 1000);

                // Set a timeout in case answer creation fails
                timeoutId = setTimeout(() => {
                    if (!answerReceived) {
                        console.error('❌ Timeout waiting for SDP answer');
                        reject(new Error('Timeout waiting for SDP answer'));
                    }
                }, 15000);
            });
        } catch (error) {
            console.error('❌ Error generating answer:', error);
            return null;
        }
    }

    private cleanupSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;

        try {
            console.log(`🧹 Cleaning up session ${sessionId}`);
            session.state = 'closed';
            session.pipeline.setState(Gst.State.NULL);
            this.sessions.delete(sessionId);
        } catch (error) {
            console.error(`❌ Error cleaning up session ${sessionId}:`, error);
        }
    }

    public start(port: number = 9090): void {
        this.app.listen(port, () => {
            console.log('🚀 WHEP GStreamer Server started');
            console.log('=====================================');
            console.log(`📡 Server running on port ${port}`);
            console.log(`📊 Health check: http://localhost:${port}/health`);
            console.log(`📋 Sessions list: http://localhost:${port}/sessions`);
            console.log(`🎶 WHEP endpoint: http://localhost:${port}/whep`);
            console.log('');
            console.log('Ready to serve audio to WHEP clients...');
            console.log('Connect with any WHEP-compatible client!');
        });
    }

    public stop(): void {
        console.log('🛑 Shutting down WHEP server...');

        // Cleanup all sessions
        for (const [sessionId] of this.sessions) {
            this.cleanupSession(sessionId);
        }

        console.log('✅ Server stopped');
        process.exit(0);
    }
}

export { WHEPGStreamerServer };
