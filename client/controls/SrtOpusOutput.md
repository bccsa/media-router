# [SrtOpusOutput.js](./SrtOpusOutput.js)

## Listener mode 
* If mode is set to caller, media-router will push the stream to the MediaMTX server that needs to run locally on the devive, with srt and hls enabled.
* Port 8890 is used for this and the stream can be read from MediaMTX with the following url: 
``srt://127.0.0.1:8890&streamid=read:{StreamID}&passphrase={srtPassphrase}``

## Caller mode 
* Work's as normal

