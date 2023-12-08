// Implementing code from MediaMTX https://github.com/bluenviron/mediamtx
// MediaMTX license notice:
// 
// MIT License

// Copyright (c) 2019 aler9

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

class WebRTCPlayer extends ui {
    constructor() {
        super();
        this.playerName = 'name';
        this.url = "";
        this.flag = "gb";
        this.message = "";
        this._pc = null; // Peer connection
        this._restartTimeout = null;
        this._sessionUrl = '';
        this._queuedCandidates = [];
        this._playState = "";
        this._disconnectTimeout;
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_mainCard}" class="flex border-4 mb-2 p-2 rounded-lg bg-stone-300">
            <span class="fi fi-${this.flag} flex-none w-12 h-8 m-2 self-center rounded-lg overflow-hidden"></span>
            <p class="grow text-2xl text-[#334155] self-center">@{playerName}</p>
            <p class="grow text-2xl text-[#334155] self-center">@{message}</p>
            <audio id="@{_audio}" class="flex flex-col self-center"></audio>
            <img id="@{_play}" src="img/play.svg" class="flex-none w-8 h-8 m-2 self-center">
            <img id="@{_pause}" src="img/stop.svg" class="flex-none w-8 h-8 m-2 self-center hidden">
        </div>     
        <audio id="@{_silence}" src="/silence.wav" type="audio/wav"></audio>   
        `;
    }

    Init() {
        // Silent audio player included to prevent the browser from sleeping on mobile devices when the screen is lockeed.
        this._silence.loop = true;

        this._play.style.display = "block";
        this._pause.style.display = "none";
        this.start();

        this._mainCard.style.cursor = "pointer"

        // Event listeners 
        this._mainCard.addEventListener('click', e => {
            if (this._play.style.display == "block") {
                // Pause and hide all other players
                Object.values(this._parent._controls).forEach(c => {
                    if (c !== this) {
                        c.visible = false;
                        c.pause();
                    }
                });
                this.play();
            } else {
                // Show all other players
                Object.values(this._parent._controls).forEach(c => {
                    c.visible = true;
                });
                this.pause();
            }
        });

        // Peer connection polling - to be tested
        setInterval(() => {
            if (this._restartTimeout !== null) {
                return;
            }

            if (this._pc && this._pc.connectionState == "connected") {
                // Reset timer if connected within 2 minutes
                if (this._disconnectTimeout) {
                    clearTimeout(this._disconnectTimeout);
                }
            } else {
                console.log('restarting...');
                this.scheduleRestart();

                if (!this._disconnectTimeout) {
                    // Wait for 2 minutes before pausing player
                    this._disconnectTimeout = setTimeout(() => {
                        this.pause();
                    }, 30000); // change to 120000 (120s)
                }
            }
        }, 1000);
    }

    play() {
        this._play.style.display = "none";
        this._pause.style.display = "block";
        this._playState = "playing";
        console.log(`Playstate: ${this._playState}`);
        this._silence.play();
        this._audio.play();

        // Set lock screen player title and state
        navigator.mediaSession.metadata = new MediaMetadata({ title: this._parent.title + " - " + this.playerName });
        navigator.mediaSession.playbackState = "playing";
    }

    pause() {
        this._play.style.display = "block";
        this._pause.style.display = "none";
        this._playState = "paused";
        console.log(`Playstate: ${this._playState}`);
        this._audio.pause();
        this._silence.pause();
        navigator.mediaSession.playbackState = "paused";
    }

    start() {
        console.log("requesting ICE servers");

        fetch(`${this.url}/whep`, {
            method: 'OPTIONS',
        })
            .then((res) => this.onIceServers(res))
            .catch((err) => {
                console.log('error: ' + err);
                this.scheduleRestart();
            });
    }

    onIceServers(res) {
        this._pc = new RTCPeerConnection({
            iceServers: linkToIceServers(res.headers.get('Link')),
        });

        const direction = "sendrecv";
        // this._pc.addTransceiver("video", { direction });
        this._pc.addTransceiver("audio", { direction });

        this._pc.onicecandidate = (evt) => this.onLocalCandidate(evt);
        this._pc.oniceconnectionstatechange = () => this.onIceConnectionState();
        this._pc.onconnectionstatechange = () => this.onConnectionState();

        this._pc.ontrack = (evt) => {
            console.log("new track:", evt.track.kind);
            this._audio.srcObject = evt.streams[0];
        };

        this._pc.createOffer()
            .then((offer) => this.onLocalOffer(offer));
    }

    onLocalOffer(offer) {
        editOffer(offer);

        this.offerData = parseOffer(offer.sdp);
        this._pc.setLocalDescription(offer);

        console.log("sending offer");

        fetch(`${this.url}/whep`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/sdp',
            },
            body: offer.sdp,
        })
            .then((res) => {
                if (res.status !== 201) {
                    throw new Error('bad status code');
                }
                this._sessionUrl = `${this.url}/${res.headers.get('location')}`;
                return res.text();
            })
            .then((sdp) => this.onRemoteAnswer(new RTCSessionDescription({
                type: 'answer',
                sdp,
            })))
            .catch((err) => {
                console.log('error: ' + err);
                this.scheduleRestart();
            });
    }

    onIceConnectionState() {
        if (this._restartTimeout !== null) {
            return;
        }

        console.log("peer connection state:", this._pc.iceConnectionState);

        switch (this._pc.iceConnectionState) {
            case "disconnected":
                this.message = "disconnected..."
                this.scheduleRestart();
        }
    }

    onConnectionState() {
        if (this._restartTimeout !== null) {
            return;
        }

        console.log("connection state:", this._pc.connectionState);

        switch (this._pc.connectionState) {
            case "closed":
            case "disconnected":
                this.scheduleRestart();
                break;
            case "connected":
                if (this._playState == "restarting") {
                    this.play();
                }
                this.message = "";
                break;
        }
    }

    onRemoteAnswer(answer) {
        if (this._restartTimeout !== null) {
            return;
        }

        this._pc.setRemoteDescription(answer);

        if (this._queuedCandidates.length !== 0) {
            this.sendLocalCandidates(this._queuedCandidates);
            this._queuedCandidates = [];
        }
    }

    onLocalCandidate(evt) {
        if (this._restartTimeout !== null) {
            return;
        }

        if (evt.candidate !== null) {
            if (this._sessionUrl === '') {
                this._queuedCandidates.push(evt.candidate);
            } else {
                this.sendLocalCandidates([evt.candidate])
            }
        }
    }

    sendLocalCandidates(candidates) {
        fetch(this._sessionUrl, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/trickle-ice-sdpfrag',
                'If-Match': '*',
            },
            body: generateSdpFragment(this.offerData, candidates),
        })
            .then((res) => {
                if (res.status !== 204) {
                    throw new Error('bad status code');
                }
            })
            .catch((err) => {
                console.log('error: ' + err);
                this.scheduleRestart();
            });
    }

    scheduleRestart() {
        if (this._restartTimeout !== null) {
            return;
        }

        if (this._playState == "playing") {
            this._playState = "restarting";
            console.log(`Playstate: ${this._playState}`);
        }

        if (this._pc !== null) {
            this._pc.close();
            this._pc = null;
        }

        this._restartTimeout = window.setTimeout(() => {
            this._restartTimeout = null;
            this.start();
        }, restartPause);

        if (this._sessionUrl) {
            fetch(this._sessionUrl, {
                method: 'DELETE',
            })
                .then((res) => {
                    if (res.status !== 200) {
                        throw new Error('bad status code');
                    }
                })
                .catch((err) => {
                    console.log('delete session error: ' + err);
                });
        }
        this._sessionUrl = '';

        this._queuedCandidates = [];
    }
}