// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiCheckbox extends _uiControl {
  constructor() {
    super();
    this.displayName = "click here";
    this.helpText = "How to use this checkBox";
    this.styleClass = "btn btn-danger";
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/js/bootstrap.min.js");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
            <!-- ${this.name} --> 
                <div>
                    <input type="checkbox"  
                    id="${this._uuid}_checkBox" 
                    name="${this.displayName}"
                    data-toggle="tooltip"
                    data-placement="rigth"
                    title="${this.helpText}"
                    >

                    <label for="horns">${this.displayName}</label>
                </div> 
            `;
  }

  DomLinkup() {
    this._checkbox = document.getElementById(`${this._uuid}_checkBox`);
    this._helpText = document.getElementById(`${this._uuid}_help`);

    let o = this;

    this._checkbox.addEventListener("change", function () {
      console.log("check this session");
    });

    // if (this._checkbox.checked == true) {
    //   console.log("element Check");
    // } else {
    //     console.log("default");
    // }
  }

  DomUpdate(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._helpText.innerHTML = this.helpText;
        break;
      }
      case "styleClass": {
        this._input.className = this.styleClass;
        break;
      }
    }
  }
}
