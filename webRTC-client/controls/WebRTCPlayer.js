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
        this.img = "";
        this.pc = null; // Peer connection
        this.restartTimeout = null;
        this.sessionUrl = '';
        this.queuedCandidates = [];
    }

    get html() {
        return `
        <!-- ${this.name} -->
        <!--    MAIN CARD CONTAINER     -->
        <div id="@{_mainCard}" class="flex border-4 mb-2 p-2 rounded-lg bg-stone-300">
            <img id="@{_img}" src="@{img}" class=" flex-none w-12 h-8 m-2 self-center rounded-lg overflow-hidden">
            <p class="grow text-2xl text-[#334155] self-center">@{playerName}</p>
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

        if (!this.img) {
            this._img.style.display = "none"
        }

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
        })
    }

    play() {
        this._play.style.display = "none";
        this._pause.style.display = "block";
        this._silence.play();
        this._audio.play();

        // Set lock screen player title and state
        navigator.mediaSession.metadata = new MediaMetadata({ title: this._parent.title + " - " + this.playerName });
        navigator.mediaSession.playbackState = "playing";
    }

    pause() {
        this._play.style.display = "block";
        this._pause.style.display = "none";
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
        this.pc = new RTCPeerConnection({
            iceServers: linkToIceServers(res.headers.get('Link')),
        });

        const direction = "sendrecv";
        // this.pc.addTransceiver("video", { direction });
        this.pc.addTransceiver("audio", { direction });

        this.pc.onicecandidate = (evt) => this.onLocalCandidate(evt);
        this.pc.oniceconnectionstatechange = () => this.onConnectionState();

        this.pc.ontrack = (evt) => {
            console.log("new track:", evt.track.kind);
            this._audio.srcObject = evt.streams[0];
        };

        this.pc.createOffer()
            .then((offer) => this.onLocalOffer(offer));
    }

    onLocalOffer(offer) {
        editOffer(offer);

        this.offerData = parseOffer(offer.sdp);
        this.pc.setLocalDescription(offer);

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
                this.sessionUrl = `${this.url}/${res.headers.get('location')}`;
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

    onConnectionState() {
        if (this.restartTimeout !== null) {
            return;
        }

        console.log("peer connection state:", this.pc.iceConnectionState);

        switch (this.pc.iceConnectionState) {
            case "disconnected":
                this.scheduleRestart();
        }
    }

    onRemoteAnswer(answer) {
        if (this.restartTimeout !== null) {
            return;
        }

        this.pc.setRemoteDescription(answer);

        if (this.queuedCandidates.length !== 0) {
            this.sendLocalCandidates(this.queuedCandidates);
            this.queuedCandidates = [];
        }
    }

    onLocalCandidate(evt) {
        if (this.restartTimeout !== null) {
            return;
        }

        if (evt.candidate !== null) {
            if (this.sessionUrl === '') {
                this.queuedCandidates.push(evt.candidate);
            } else {
                this.sendLocalCandidates([evt.candidate])
            }
        }
    }

    sendLocalCandidates(candidates) {
        fetch(this.sessionUrl, {
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
        if (this.restartTimeout !== null) {
            return;
        }

        if (this.pc !== null) {
            this.pc.close();
            this.pc = null;
        }

        this.restartTimeout = window.setTimeout(() => {
            this.restartTimeout = null;
            this.start();
        }, restartPause);

        if (this.sessionUrl) {
            fetch(this.sessionUrl, {
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
        this.sessionUrl = '';

        this.queuedCandidates = [];
    }
}