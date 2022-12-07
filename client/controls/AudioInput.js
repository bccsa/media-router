class AudioInput extends _audioDevice {
    constructor() {
        super();
        this.device = "New device";
    }

    Init() {
        super.Init();

        this.SetData( {audioInput: { controlType: "_audioDevice", hidden: true, description: this.device }});
        this.on('device', device => {this.audioInput.description = device});
        this.on('audioInput', () => {
            this.audioInput.on('description', description => {this.device = description});
        });
        
    }
}