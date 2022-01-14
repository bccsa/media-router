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
            <button type="button" id="${this._uuid}_buttonModal" class="btn btn-primary" data-toggle="modal" data-target="#exampleModal">
            ${this.displayName}
            </button>
             
          `;
  }

  DomLinkup() {
    this._buttonOk = document.getElementById(`${this._uuid}_buttonOk`);
    this._buttonCancel = document.getElementById(`${this._uuid}_buttonCancel`);
    this._buttonModal = document.getElementById(`${this._uuid}_buttonModal`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);

    let o = this;
    this._buttonModal.addEventListener("click", function () {
      confirm("Press a button!\nEither OK or Cancel.");
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
