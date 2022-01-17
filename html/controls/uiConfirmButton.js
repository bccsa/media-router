// Implementing Sweet Alert JS here
// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiConfirmButton extends _uiControl {
  constructor() {
    super();
    this.displayName = "The modal";
    this.helpText = "Modal for confirmation";
    this.styleClass = "btn btn-danger";
    this._styles.push("controls/css/bootstrap.min.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
          <!-- ${this.name} -->
          <button id="${this._uuid}_buttonModal" > ${this.displayName}</button>
          <div id="${this._uuid}_confirm-box" style="position: center; background-color:grey; width: 300px; height: 200px;padding: 50px; padding-top: 80px">
              <button 
                type="button" 
                id="${this._uuid}_buttonOk" 
                class="btn btn-success m-1">
                  Confirm
              </button>

              <button 
                type="button" 
                id="${this._uuid}_buttonCancel" 
                class="btn btn-danger m-1">
                  Cancel
              </button> 
          </div>     
      `;
  }

  DomLinkup() {
    this._buttonOk = document.getElementById(`${this._uuid}_buttonOk`);
    this._buttonCancel = document.getElementById(`${this._uuid}_buttonCancel`);
    this._buttonModal = document.getElementById(`${this._uuid}_buttonModal`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);

    let o = this;
    this._buttonModal.addEventListener("click", function () {
      console.log("true");
    });
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._helpText.innerHTML = this.helpText;
        break;
      }
      case "styleClass": {
        this._button.className = this.styleClass;
        break;
      }
    }
  }
}
