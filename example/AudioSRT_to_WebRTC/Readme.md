This example shows how to send an Audio Input Via SRT to MediaMTX that in return
can be listend to via the WebRTCClient App.

Audio Input (via a Webcam) -> SRT_Opus_Output -> MediaMTX -> WebRTCClient

steps to reproduce:

- copy managerConf.json and profielConf.json to ../server
- run
```bash
$ docker-compose up
```
- Configure Audio Input