// =====================================
// Expander label and helptext
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiExpander extends _uiControl {
  constructor() {
    super();
    this.displayName = "new control"; // Display name
    this.helpText = "new control help text";
    this.margin = "10px";
    this.padding = "10px";
    this._c_statusName = new uiStatus();

    // Set static controls values
    this._c_statusName.displayName = "Control 1";
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <div id="${this._uuid}_main" class="row col-lg-12" style="margin:${this.margin}">
            <div id="${this._uuid}_topBar" class="col-lg-12 p-3" style="background-color:grey;  ">
                <span id="${this._uuid}_label">${this.displayName}</span>
                 ${this._c_statusName.html}  
            </div>
            <div id="${this._uuid}_controls" style="padding:${this.padding};  width:100%; display:none;"></div>
        </div>`;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._label = document.getElementById(`${this._uuid}_label`);
    this._topBar = document.getElementById(`${this._uuid}_topBar`);
    this._status = document.getElementById(`${this._uuid}_status`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);

    let o = this;
    this._topBar.addEventListener("dblclick", function () {
      if (o._controlsDiv.style.display != "block") {
        o._controlsDiv.style.display = "block";
      } else {
        o._controlsDiv.style.display = "none";
      }
    });
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._label.innerText = this.displayName;
        break;
      }
    }
  }
}
