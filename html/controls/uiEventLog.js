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
    this.logText = "Terminal"; 
    this._styles.push("controls/css/uiEventLog.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
              <!-- ${this.name} --> 
                  <div id="${this._uuid}_main" class=""> 
                       <div class="uiEventLog-terminal"   >
                            <p id="${this._uuid}_eventLog" >${this.logText}</p>
                       </div>
                  </div> 
              `;
  }

  Init() {
    this._eventLog = document.getElementById(`${this._uuid}_eventLog`);
    //  this._terminal = document.getElementById(`${this._uuid}_terminal`);

    // setInterval(() => {
    //   this._eventLog.innerHTML = this.displayName;
    // }, 3000);
  }

  Update(propertyName) {
    switch (propertyName) {
      case "logText": {
        this._eventLog.innerHTML += this.logText;
        break;
      }
    }
  }
}
