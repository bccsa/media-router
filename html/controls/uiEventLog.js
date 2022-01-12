// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiEventLog extends _uiControl {
  constructor() {
    super();
    this.displayName = "Terminal";
    this.helpText = "How to use this event log";
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/terminal.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
              <!-- ${this.name} --> 
                  <div class="row">
                       <div class="terminal">
                            <p class="" id="${this._uuid}_eventLog" > ${this.displayName} . . . . </p>
                       </div>
                  </div> 
              `;
  }

  DomLinkup() {
    this._eventLog = document.getElementById(`${this._uuid}_checkBox`);
    this._helpText = document.getElementById(`${this._uuid}_help`);

    let o = this;
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._helpText.innerHTML = this.helpText;
        break;
      }
      case "styleClass": {
        this._input.className = this.styleClass;
        break;
      }
    }
  }
}
