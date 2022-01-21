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
    this.styleClass = "btn btn-default m-1";
    this._styles.push("controls/css/bootstrap.min.css");
    // this._styles.push("controls/js/bootstrap.min.js");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} -->
         
          <button class="${this.styleClass}" 
            id="${this._uuid}_button" 
            data-toggle="tooltip" 
            data-placement="top" 
            style="background-color:grey;
            title="${this.helpText}" >${this.displayName}</button>
           
         
        `;
  }

  DomLinkup() {
    this._button = document.getElementById(`${this._uuid}_button`);
    this._helpText = document.getElementById(`${this._uuid}_helpText`);

    let o = this;
    this._button.addEventListener("click", function () {
      o.dispatch("click", o);
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
      case "displayName": {
        this._button.value = this.displayName;
      }
    }
  }
}
