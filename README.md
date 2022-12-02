# media-router
Configurable media router.
Modules (devices):
* AudioInput: Capture audio from hardware and output to a PCM stream.
* AudioOutput: Play a PCM audio stream to hardware.
* AudioMixer: Mix audio via AudioMixerInputs and output to a PCM stream.
* AudioMixerInput: Input audio from a PCM audio stream into a AudioMixer. Includes a web control interface with mute and volume controls.
* RtpOpusInput: Receive Opus encoded audio via RTP, and decode to PCM.
* RtpOpusOutput: Encode PCM audio to Opus and send via RTP.
* SrtInput: Receives an SRT stream and publishes it to a UDP socket.
* SrtOutput: Reads a UDP socket and publishes it as a SRT stream.
* Spacer: Visual spacer for web control interface.


The web control interface is available on port 8081.

## Compatibility
This project has been tested on Raspberry Pi OS Bullseye

## Dependencies
Run the installation script:
```
sudo ./install-dependencies.sh
```

## Development environment
* Clone the project to your Raspberry Pi.
* Navigate to the media-router directory
* Run the router.js with NodeJS: ```node server.js```
* A default configuration file will be created listing all the modules. This file can be modified to create a working setup. The server.js script should be restarted to apply the configuration changes.

## Installation: Tailwind CLI and Tailwind Elements

### 1. Install Tailwind CSS
Install tailwindcss via npm, and create your tailwind.config.js file.
```
sudo npm install -D tailwindcss
sudo npx tailwindcss init
```

### 2. Add the Tailwind directives to your CSS
* Create new folder **"src"**
* Create new file **"input.css"**
* Add the @tailwind directives for each of Tailwind’s layers to your main CSS file.
```
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### 3. Install Tailwind Elements
* Run the following command to install the package via NPM
```
sudo npm install tw-elements
```

### 4. Update the config file **"tailwind.config.js"**
```
module.exports = {
  content: ['./src/**/*.{html,js}', './node_modules/tw-elements/dist/js/**/*.js'],
  plugins: [
    require('tw-elements/dist/plugin')
  ]
}
```

### 5. Start the Tailwind CLI build process
* Save all your files before running the build process
* Run the CLI tool to scan your template files for classes and build your CSS.
```
sudo npx tailwindcss -i ./src/input.css -o ./dist/output.css
```


### 6. Start using Tailwind in your HTML
* Add your compiled CSS file to the <head> and start using Tailwind’s utility classes to style your content:

    `<link href="/dist/output.css" rel="stylesheet">`
* Dynamic components will work after adding the js file:

    `<script src="./TW-ELEMENTS-PATH/dist/js/index.min.js"></script>`


## Example configurations
To do
