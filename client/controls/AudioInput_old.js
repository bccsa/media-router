class AudioInput extends _audioDevice {
    constructor() {
        super();
        this.device = "New device";
    }

    Init() {
        super.Init();

        this.SetData( {audioIODevice: { controlType: "_audioIODevice", hidden: true, description: this.device }});
        this.on('device', val => {this.audioIODevice.device = val});
        this.on('bufferSize', val => {this.audioIODevice.bufferSize = val});
        
        // Handle child control property changes
        this.on('audioIODevice', () => {
            this.audioIODevice.on('device', val => {this.device = val});
            this.audioIODevice.on('bufferSize', val => {this.bufferSize = val});
        });
        
    }
}