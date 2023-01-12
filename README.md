# media-router
Configurable media router.

## client
Client web interface for the manager and router

## server
NodeJS scripts for the router and manager





Modules:
* AudioInput: Capture audio from hardware and output to a PCM stream.
* AudioOutput: Play a PCM audio stream to hardware.
* SrtOpusInput: Receives an SRT Opus encoded audio stream
* SrtOpusOutput: Publishes an audio stream as Opus encoded SRT. 
* Spacer: Visual spacer for web control interface.


The client web control interface is available on port 8081.

## Compatibility
This project has been tested on Raspberry Pi OS Buster

## Development environment
* Clone the project to your Raspberry Pi.
* Navigate to the ```media-router``` directory
* Install dependencies ```sudo ./install-dependencies.sh```
* Run the router.js with NodeJS: ```node server.js```

## Installation: Tailwind CLI and Tailwind Elements

### 1. Install Tailwind CSS
Install tailwindcss via npm, and create your tailwind.config.js file.
```
sudo npm install -D tailwindcss
sudo npx tailwindcss init
```

### 2. Add the Tailwind directives to your CSS
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
  content: ['./client/**/*.{html,js}', './node_modules/tw-elements/dist/js/**/*.js'],
  plugins: [
    require('tw-elements/dist/plugin')
  ]
}
```

### 5. Start the Tailwind CLI build process
* Save all your files before running the build process
* Run the CLI tool to scan your template files for classes and build your CSS.
```
sudo npx tailwindcss -i ./input.css -o ./client/output.css
```


### 6. Start using Tailwind in your HTML
* Add your compiled CSS file to the <head> and start using Tailwind’s utility classes to style your content:

    `<link href="/dist/output.css" rel="stylesheet">`
* Dynamic components will work after adding the js file:

    `<script src="./TW-ELEMENTS-PATH/dist/js/index.min.js"></script>`


## Example configurations
To do

## Module structure
Modules are NodeJS classes extending the ```_device``` base class. The ```_audioInputDevice``` and ```_audioOutputDevice``` classes (also extending ```_device```) provides additional functionality for audio inputs (volume & mute control and level indication) and audio outputs (built-in audio mixer capabilities with volume & mute control and level indication).

### _device
The ```_device``` base class provides the following base functionality:

**Parent/Child structure**

The _device base class provides a parent/child structure, where modules can be added as child modules to another module. Adding modules is done through the ```SetConfig()``` function by passing javascript object structured data to the parent module. ```SetConfig()``` creates the module structure according to the passed javascript object structure, and sets valid passed parameters. Modules are identified by the ```deviceType``` parameter. The module object structure is thus fully accessible externally.

Example:
```javascript
parent.SetConfig({
    child1: {
        deviceType: "ModuleType1",
        property1: "value1",
        property2: "value2"
    },
    child2: {
        deviceType: "ModuleType2",
        propertyA: "valueA",
        propertyB: "valueB",
        grandChild1: {
            deviceType: "ModuleType3",
            propertyZ: "valueZ"
        }
    }
});
```

**Dynamic class loading**

*To do*

**NodeJS events**

The ```_device``` base class extends the built-in NodeJS events module. Any event can be emitted, subscribed to and unsubscribed from through the ```module.emit()```, ```module.on()```, ```module.off()``` and ```module.once()``` functions.

**Automatic creation of getters and setters and property change events**

The ```_device``` base class automatically creates getters and setters for predefined class properties with property names not starting with "_" and with types ```String```, ```Number```, ```Boolean``` and ```Array```. Properties added dynamically to modules (implementing ```_device```) are not modified.

Property values copied and saved as key/value pairs in the ```module._properties``` object. The setters will emit an event with the property name and value when the property value is set.

Example: Subscribing to property change notifications for a module.property1 property
```javascript
module.on('property1', value => {
    // logic handling value change
});
```

**External notification**

In addition to property change notifications, it may be necessary to notify property values in the module's structure format. The ```module.NotifyProperty()``` function will emit a ```'data'``` event on the top level parent with the property name and value, including the path to the property.

Example:
```javascript
// Create child controls
parent.SetConfig({
    child1: {
        deviceType: "ModuleType2",
        propertyA: "valueA",
        propertyB: "valueB",
        grandChild1: {
            deviceType: "ModuleType3",
            propertyZ: "valueZ"
        }
    }
});

// Listen for data
parent.on('data', data => {
    // Expected output: see below
});

// Notify grandChild1's propertyZ (this will usually be implemented in ModuleType3's internal logic, but for the sake of the example it is triggered externally).
parent.child1.grandChild1.NotifyProperty('propertyZ');
```

The expected output from the ```'data'``` event is
```javascript
{
    child1: {
        grandChild1: {
            propertyZ: "valueZ"
        }
    }
}
```

**Updating module properties through module.SetConfig()**

In addition to creating new modules, ```SetConfig()``` can be used to pass properties to modules. Setting one or several properties in the module's data structure through ```SetConfig()``` will apply the property values to the modules as per the passed structure. Using the above example, the same data structure that was received through the ```'data'``` event can be applied to set the property/ies value(s).

**Getting the full module structure through module.GetConfig()**

The full module structure (including child modules) can generated by calling ```module.GetConfig()```. This can be used to store configuration to disk, which can be used on startup to load the last state by setting the saved configuration using ```module.SetConfig()```.

**Special purpose properties**

The ```_device``` base class includes the following special purpose properties:

```run```

The ```module.run``` Boolean property's setter is modified to run the _start() and _stop() functions before emitting the updated property value.

The ```_device``` base class also automatically subscribes to parent ```'run'``` events, and sets it's own ```run``` property to the value received through the parent's ```'run'``` event. This is used for coordinated starting and stopping of implementing modules.

```name```

Name of the module (e.g. ```MyAudioInput```).

**Override functions**
Implementing modules (classes) may override the following functions to implement functionality:

```_start()```

Override the start function to implement module starting logic (e.g. starting of an external process to capture audio).

```_stop()```

Override the stop function to implement module stopping logic (e.g. stopping of an external audio capturing process).