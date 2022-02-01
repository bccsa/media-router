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
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiExpander.css");

    // Add header controls container to the topBar element
    this.SetData({
      header: {
        controlType: "uiSimpleContainer",
        name: "header",
        displayName: this.displayName,
        parentElement: "_topBar",
      }
    });
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <div id="${this._uuid}_main" class="col-lg-12" style="margin:${this.margin}">
        <!-- ${this.name} -->
        <div id="${this._uuid}_topBar" class="col-lg-12 p-2 d-flex" style="background-color:grey;">
          <span class="title col-lg-6" id="${this._uuid}_label">${this.displayName}</span>          
        </div>
        <div id="${this._uuid}_controls"></div>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
    this._label = document.getElementById(`${this._uuid}_label`);
    this._topBar = document.getElementById(`${this._uuid}_topBar`);

    // Add event listeners
    let o = this;
    this._topBar.addEventListener("dblclick", function () {
      if (o._controlsDiv.style.display != "block") {
        o._controlsDiv.style.display = "block";
      } else {
        o._controlsDiv.style.display = "none";
      }
      console.log(o._controlsDiv.style.display);
    });
  }

  Update(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._label.innerText = this.displayName;
        break;
      }
    }
  }
}
