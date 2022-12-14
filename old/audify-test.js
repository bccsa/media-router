const { RtAudio, RtAudioFormat, RtAudioApi, RtAudioStreamFlags } = require("audify");

// Init RtAudio instance using default sound API
const rtAudio = new RtAudio();
//RtAudioApi.LINUX_ALSA
// Open the input/output stream
rtAudio.openStream(
	{ deviceId: 1, // Output device id (Get all devices using `getDevices`)
	  nChannels: 2, // Number of channels
	  firstChannel: 0 // First channel index on device (default = 0).
	},
	{ deviceId: 1, // Input device id (Get all devices using `getDevices`)
	  nChannels: 2, // Number of channels
	  firstChannel: 0 // First channel index on device (default = 0).
	},
	RtAudioFormat.RTAUDIO_SINT32, // PCM Format - Signed 16-bit integer
	44100, // Sampling rate is 48kHz
	1920, // Frame size is 1920 (40ms)
	"MyStream", // The name of the stream (used for JACK Api)
	pcm => rtAudio.write(pcm), // Input callback function, write every input pcm data to the output buffer
	null,
	//RtAudioStreamFlags.RTAUDIO_SCHEDULE_REALTIME
);

// Start the stream
rtAudio.start();