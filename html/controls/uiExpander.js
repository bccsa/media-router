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
    this.button1 = new uiButton();
    this.button1.displayName = " Device";
    this.button2 = new uiButton();
    this.button3 = new uiButton();
    this.button4 = new uiButton();
    this.terminal1 = new uiEventLog();
    this._styles.push("controls/css/terminal.css");

    // Add header controls container to the topBar element
    this.SetData({
      header: {
        controlType: "uiSimpleContainer",
        name: "header",
        displayName: this.displayName,
        parentElement: "_topBar",
      },
      deleteBtn: {
        controlType: "uiButton",
        name: "deleteBtn",
        displayName: "Delete",
        parentElement: "_topBar",
        hidden: true,
      },
    });
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} --> 
        <div id="${this._uuid}_main" class="col-lg-12 "   style="margin:${this.margin}">
            <div id="${this._uuid}_topBar" class="col-lg-12 p-2 d-flex" style="background-color:grey;">
               
            <span id="${this._uuid}_label">${this.displayName}</span>  
                 
            </div>
            <div 
            id="${this._uuid}_controls" 
            class="row" 
            style="display: 
            flex; margin-left; 
            padding:${this.padding};
            width:100%;
            display:none;
            ">
                <div class="d-flex">
                      ${this.button1.html}
                      ${this.button2.html}
                      ${this.button3.html}
                      ${this.button4.html}
                </div>

                <div>
                    ${this.terminal1.html}
                </div>
            </div>
        </div>`;
  }

  DomLinkup() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._label = document.getElementById(`${this._uuid}_label`);
    this._topBar = document.getElementById(`${this._uuid}_topBar`);
    this._controlsDiv = document.getElementById(`${this._uuid}_controls`);

    // Add event listeners
    let o = this;
    this._topBar.addEventListener("dblclick", function () {
      if (o._controlsDiv.style.display != "block") {
        o._controlsDiv.style.display = "block";
      } else {
        o._controlsDiv.style.display = "none";
      }
      console.log(this._controlsDiv);
    });

    // Listen for delete button event
    this._controls["deleteBtn"].on("click", () => {
      // Delete this control
      this.DomRemove();
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
