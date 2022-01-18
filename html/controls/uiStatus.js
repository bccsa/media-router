// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiStatus extends _uiControl {
  constructor() {
    super();
    this.helpText = "get you status";
    this.styleClass = "p-2 m-1";
    this.statusUpdate = "";
    // this.styles.push("controls/css/bootstrap.min.css");
    this.displayName = "Status Control";
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
            <!-- ${this.name} -->
            
            <button class="${this.styleClass}" 
              style="border: 0.5px solid grey; border-radius: 15px; "
              id="${this._uuid}_status" 
              data-toggle="tooltip" 
              data-placement="top" 
              title="${this.helpText}" > ${this.displayName} </button>
            
           
            `;
  }

  DomLinkup() {
    this._status = document.getElementById(`${this._uuid}_status`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);

    // let o = this;
    setInterval(() => {
      this._status.innerHTML = this.displayName;
    }, 3000);
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._status.innerHTML = this.displayName;
        break;
      }
    }
  }
}
