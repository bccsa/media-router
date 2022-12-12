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
    this.statusUpdate = ""; 
    this.displayName = "Status Control";
    this._styles.push("controls/css/uiStatus.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
            <!-- ${this.name} -->
            
            <button class="uiStatus"  
              id="${this._uuid}_status" 
              data-toggle="tooltip" 
              data-placement="top" 
              title="${this.helpText}" > ${this.displayName} </button>
            
           
            `;
  }

  Init() {
    this._status = document.getElementById(`${this._uuid}_status`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);

    // let o = this;
    setInterval(() => {
      this._status.innerHTML = this.displayName;
    }, 3000);
  }

  Update(propertyName) {
    switch (propertyName) {
      case "displayName": {
        this._status.innerHTML = this.displayName;
        break;
      }
    }
  }
}
