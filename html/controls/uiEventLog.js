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
                  <div   class="row"> 
                       <div id= class="terminal" style="height: 300px;
                       background-color: #000;
                       color: #fff; 
                       width: 100%;
                       padding: 14px; 
                       margin: 10px;" >
                            <p class="" id="${this._uuid}_eventLog" > ${this.displayName} . . . . </p>
                       </div>
                  </div> 
              `;
  }

  DomLinkup() {
    this._eventLog = document.getElementById(`${this._uuid}__eventLog`);
    //  this._terminal = document.getElementById(`${this._uuid}_terminal`);

    setInterval(() => {
      this._eventLog.innerHTML = this.displayName;
    }, 3000);
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._helpText.innerHTML = this.displayName;
        break;
      }
      // case "styleClass": {
      //   this._terminal.className = this.styles;
      //   break;
      // }
    }
  }
}
