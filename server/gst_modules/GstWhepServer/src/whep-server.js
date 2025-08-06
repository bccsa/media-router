const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 8080;

// Enable CORS and JSON parsing
app.use(
    cors({
        origin: '*',
        credentials: true,
        exposedHeaders: ['Location', 'Content-Type'],
    })
);
app.use(express.json());
app.use(express.text({ type: 'application/sdp' }));

// Store active sessions
const sessions = new Map();

// WHEP endpoint for creating a new session
app.post('/whep', (req, res) => {
    console.log('POST /whep - Creating new WHEP session');
    console.log('Content-Type:', req.get('content-type'));
    console.log('SDP Offer received (length):', req.body ? req.body.length : 0);

    // Validate SDP offer
    if (!req.body || typeof req.body !== 'string' || !req.body.includes('v=0')) {
        console.error('Invalid SDP offer received');
        return res.status(400).json({ error: 'Invalid SDP offer' });
    }

    // Generate session ID
    const sessionId = uuidv4();

    // Store session data
    const session = {
        id: sessionId,
        offer: req.body,
        answer: null,
        iceCandidates: [],
        created: new Date(),
        state: 'waiting-for-answer',
    };

    sessions.set(sessionId, session);
    console.log(`Created session: ${sessionId}`);

    // Generate SDP answer that matches the offer
    const sdpAnswer = generateSdpAnswer(req.body);
    session.answer = sdpAnswer;
    session.state = 'connected';

    // Set WHEP-specific headers
    res.set({
        'Content-Type': 'application/sdp',
        Location: `/whep/${sessionId}`,
        'Access-Control-Expose-Headers': 'Location',
    });

    console.log(`Sending SDP answer for session ${sessionId}`);
    res.status(201).send(sdpAnswer);
});

// WHEP session management endpoint
app.get('/whep/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    res.json({
        id: session.id,
        state: session.state,
        created: session.created,
        iceCandidatesCount: session.iceCandidates.length,
    });
});

// Delete WHEP session
app.delete('/whep/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    sessions.delete(sessionId);
    console.log(`Deleted session: ${sessionId}`);
    res.status(200).json({ message: 'Session deleted' });
});

// ICE candidate endpoint (WHEP extension)
app.patch('/whep/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);

    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }

    // Handle ICE candidates
    if (req.get('content-type') === 'application/trickle-ice-sdpfrag') {
        console.log(`Received ICE candidate for session ${sessionId}:`, req.body);
        session.iceCandidates.push({
            candidate: req.body,
            timestamp: new Date(),
        });
        return res.status(204).send();
    }

    res.status(400).json({ error: 'Unsupported content type' });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});

// List all sessions (for debugging)
app.get('/sessions', (req, res) => {
    const sessionList = Array.from(sessions.values()).map(session => ({
        id: session.id,
        state: session.state,
        created: session.created,
        iceCandidatesCount: session.iceCandidates.length,
    }));

    res.json({
        sessions: sessionList,
        count: sessionList.length,
    });
});

// Options endpoint for CORS preflight
app.options('/whep', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.status(200).send();
});

function generateSdpAnswer(offer) {
    console.log('Generating SDP answer for offer...');

    // Extract session info from offer
    const sessionId = Math.random().toString(36).substring(2, 15);
    const timestamp = Date.now();

    // Parse offer to extract media capabilities
    const offerLines = offer.split('\n');
    let audioPort = 9;
    let rtpMap = '';
    let fmtp = '';

    // Extract RTP parameters from offer
    for (const line of offerLines) {
        if (line.startsWith('a=rtpmap:111')) {
            rtpMap = line;
        } else if (line.startsWith('a=fmtp:111')) {
            fmtp = line;
        }
    }

    // Generate ICE credentials
    const iceUfrag = Math.random().toString(36).substring(2, 10);
    const icePwd = Math.random().toString(36).substring(2, 26);

    // Generate a proper SDP answer for audio-only WebRTC
    const sdpAnswer = `v=0
o=- ${timestamp} 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS stream
m=audio ${audioPort} UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:${iceUfrag}
a=ice-pwd:${icePwd}
a=ice-options:trickle
a=fingerprint:sha-256 A1:B2:C3:D4:E5:F6:G7:H8:I9:J0:K1:L2:M3:N4:O5:P6:Q7:R8:S9:T0:U1:V2:W3:X4:Y5:Z6
a=setup:active
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=extmap:2 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid
a=recvonly
a=rtcp-mux
${rtpMap || 'a=rtpmap:111 opus/48000/2'}
a=rtcp-fb:111 transport-cc
${fmtp || 'a=fmtp:111 minptime=10;useinbandfec=1'}
a=ssrc:${Math.floor(Math.random() * 1000000)} cname:${sessionId}
`;

    console.log('Generated SDP answer');
    return sdpAnswer;
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 WHEP Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`📋 Sessions list: http://localhost:${PORT}/sessions`);
    console.log(`🎵 WHEP endpoint: http://localhost:${PORT}/whep`);
    console.log('');
    console.log('Ready to accept WHEP connections...');
});

module.exports = app;
