# modular-dm

A data-first, event driven, parent-child structured data model for NodeJS compatible with [modular-ui](https://github.com/bccsa/modular-ui)'s data model.

## Installing modular-dm

## Creating control classes

Create a directory for your data model classes (e.g. `controls`). The javascript file names should match the class name defined in the class javascript files.

`controls/house.js`

```javascript
const { dm } = require("../modular-dm");

class house extends dm {
    constructor() {
        super();
        this.streetNumber = "";
    }

    Init() {
        // Initialization logic. This function is called after control creation.
    }
}

module.exports = house;
```

`controls/room.js`

```javascript
const { dm } = require("../modular-dm");

class room extends dm {
    constructor() {
        super();
        this.doors = 1;
        this.windows = 1;
    }

    Init() {
        // Initialization logic. This function is called after control creation.
    }
}

module.exports = room;
```

## Creating a data model

`index.js`

```javascript
const { dmTopLevelContainer } = import('./modular-dm');

// Path to modular-dm control class files (passed to top level container) should be the absolute path to the control files directory
// or the relative path from the directory where modular-dm is installed.
var controls = dmTopLevelContainer('../controls')

// Create the data model
controls.Set({
    house1: {
        controlType: 'house',
        room1: {
            controlType: 'room',
            windows: 2,
        },
        room2: {
            controlType: 'room'
            doors: 2,
        }
    },
    house2: {
        controlType: 'house',
        room1: {
            controlType: 'room',
            windows: 3,
            doors: 2
        },
        room2: {
            controlType: 'room'
            doors: 2,
        }
    }
});
```

## Event subscription

### control.on()

Explain options { immeditate: true }.

---

## Extend Classes

### Standard

use standard javascript to extend a class

```js
const ClassB = require('./ClassB');

class ClassA extends ClassB {
    ...
}
```

### Extend a class with multiple classes

modular-ui build in function to extend a javascript class with muiltiple other classes

-   **_Importand to note that if more that one superclass contains a property/ function that has the same name, it will be overwritten by the last class containing that propery/ function_**

```js
const ClassB = require('./ClassB');
const ClassC = require('./ClassC');
const ClassD = require('./ClassD');

class ClassA extends _uiClasses(ClassB, ClassC, ClassD) {
    ...
}
```

## SetAccess

Access control list { Set: 'public'(default)/'none', Get: 'public'(default)/'none', setter: 'public'(default)/'none', getter: 'public'(default)/'none' }
where 'Set' refers to data set through control.Set(),
'Get' refers to data retreived through control.Get() or through automatic notification,
'setter' refers to setting the property through control.property = value and
'getter' refers to getting the property value through value = control.property.
'private' = only accessible by the control itself,
'public' = accessible by any other controls / external code, none = not accessible at all

### Example

`controls/room.js`

```javascript
const { dm } = require("../modular-dm");

class room extends dm {
    constructor() {
        super();
        this.doors = 1;
        this.windows = 1;
        this.SetAccess("windows", { Get: "None", Set: "private" });
    }

    Init() {
        // Initialization logic. This function is called after control creation.
    }
}

module.exports = room;
```

## SetMeta

SetMeta is used to pass meta data with properties when they are updated

### Example

`controls/room.js`

```javascript
const { dm } = require("../modular-dm");

class room extends dm {
    constructor() {
        super();
        this.doors = 1;
        this.windows = 1;
        this.SetMeta("windows", { meta1: true, meta2: "Some other value" });
    }

    Init() {
        this.on("data", (val, meta) => {
            console.log(val + " | " + meta);
            // will log: '2 | { windows: { meta1: true, meta2: "Some other value" } }'
        });

        this.on("window", (val, meta) => {
            console.log(val + " | " + meta);
            // will log: '2 | { windows: { meta1: true, meta2: "Some other value" } }'
        });

        this.window = 2;
    }
}

module.exports = room;
```

# To do

-   Document event subscription (on & once) options
-   Unsubscribe from caller 'remove' event on event unsubscription
