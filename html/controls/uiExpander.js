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
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <div id="${this._uuid}_main" class="row col-lg-12" style="margin:${this.margin}">
            <div id="${this._uuid}_topBar" class="col-lg-12 p-3" style="background-color:grey;">
                <span id="${this._uuid}_label">${this.displayName}</span>
            </div>
            <div id="${this._uuid}_controls" style="padding:${this.padding};width:100%;display:none;"></div>
        </div>`;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._label = document.getElementById(`${this._uuid}_label`);
    this._topBar = document.getElementById(`${this._uuid}_topBar`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    
    // Add header controls container to the topBar element
    let h = new uiSimpleContainer();
    h.name = "header";
    this.AddControl(h, "_topBar");

    // Add event listeners
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
