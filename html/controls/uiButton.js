// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiButton extends _uiControl {
  constructor() {
    super();
    this.displayName = "click here";
    this.helpText = "How to use this button";
    this._styles.push("controls/css/uiButton.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <!-- ${this.name} -->
      <div id="${this._uuid}_main" data-toggle="tooltip" data-placement="top" title="${this.helpText}">
        <button id="${this._uuid}_button" class="uiButton" >
          ${this.displayName}
        </button>
      </div>`;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._button = document.getElementById(`${this._uuid}_button`);

    // Event handling
    let o = this;
    this._button.addEventListener("click", function () {
      o.dispatch("click", o);
    });
  }

  Update(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._button.title = this.helpText;
        break;
      }
      case "displayName": {
        this._button.value = this.displayName;
      }
    }
  }
}
