# HLS Player 

## Input settings (<b>NB!! Need to reload the module for the changes to teke effect</b>)
* HLS URL - m3u8 URL
* Default Language - Language you want to playout with the video (List will be populated withing a few seconds after the HLS URL is added)
* Video Quality - Video playout quality (List will be populated withing a few seconds after the HLS URL is added)
* Audio Streams - List of streams that you want to playout in addition to the default language, virtual device will be created for each audio stream (List will be populated withing a few seconds after the HLS URL is added)
* Output Over SRT - Playout Video and default language over SRT instead if the screen (See Info on SRT settings in addition)
* Video Delay (ms) - Delay the video and default language in milliseconds 

### How to get a m3u8 url from a web player: 
1. Open a new tab in your browser
2. Press F12 to open dev tools 
3. Go to newtork 
4. In the filter box search m3u8
4. Open the website you want to get the m3u8 from
5. Start playing the video 
6. One of the first hits in the network tab should be a m3u8 url, you are looking for a file that is called toplevel.m3u8 / playlist.m3u8 / index.m3u8 (Your are <b>NOT</b> looking for files tipically named chunks.m3u8 / index_1.m3u8 / index_2.m3u8)
7. Right click on the first file you are looking for and say copy Url
8. Paste the url in the Hls Url box (On the media-router)

### How to use additional audio streams
1. Select the audio streams you want to use (eg. English and French)
2. Reload the HLS Player and make sure the router is running
3. And a new Audio Input for each audio stream
4. As the source in the audio input the select the new source created by the HLS player with the stream name in its name (e.g "Monitor of HlsPlayer_4172_sink_fra (Française)")
5. Reload the audio input and you should see the audio play, if there is audio coming from the HLS playlist
