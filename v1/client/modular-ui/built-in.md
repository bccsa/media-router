### Built-in properties
* controls -> Returns a list of child modular-dm controls.
* parent -> Returns the parent control.
* topLevelParent -> Returns the top level parent.
* controlType -> Returns the control type name (String).
* controls -> Returns a list of child controls.
* controlName -> Control internal name (key in the object data passed to Set()).

### Built-in methods
* Set(data) -> Set modular-dm data.
* Get() -> Get a deep copy of the modular-dm data (not referenced).
* Log(message) -> Log events to an event log (exposed as 'log' event on the top level parent).
* NotifyProperty(propertyNames) -> Notifies parent control of a change to the given property or array of properties and triggers the data event on the top level parent.
* Notify(data) -> Wraps the passed data in a Javascript object containing the path to this control, and emits the wrapped object as a 'data' event on the top level parent.
* Init() -> Overridable method that is called directly after control creation. The [controlName] event is emitted on the control's parent directly after Init() is called. The Init() method can be overridden to add initialisation logic to extentions of the modular-dm base class.
* on('eventName', callback) -> Subscribe to an event with name [eventName].
* off('eventName', callback) -> Unsubscrive from an event with name [eventName].
* once('eventName', callback) -> ################################################
* emit('eventName', data, scope) -> Emit an event. Scope (optional): local: Only emit on this control; bubble: Emit on this control and all parent controls; top: Only emit on top level parent control; local_top: Emit on both this control and top level parent control; (Default: local)

### Built-in events
* data -> Emits when data changes is notified (either through Notify() or when a property value is changed). This is only emitted on the top level parent. Note: The data event is not fired when a property value is changed through Set().
* [property] -> Any class property of string, boolean or number type which the property name does not start with a "_" character will emit an event named the same as the property with the updated property value. This is emitted locally on the control owning the property.
* [controlName] -> When a child control is created, the parent emits an event named the name of the child control and passes a reference to the newly created control. This event is emitted directly after the Init() method is called.
