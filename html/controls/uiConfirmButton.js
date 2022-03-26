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
    this.displayName = "Confirm button";
    this.helpText = "Confirm button help text";
    this.message = "do you want to confirm this ?"; 
    this._styles.push("controls/css/uiConfirmButton.css");
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
        <!-- ${this.name} -->
        <div id="${this._uuid}_main">
          <button
            class="uiConfirmBtn"
            data-toggle="tooltip"
            data-placement="top"
            title="${this.helpText}"
            id="${this._uuid}_buttonModal">
              ${this.displayName}
          </button>

          <div id="${this._uuid}_confirmBox" class="uiConfirmButton">
            <div class="uiConfirmButton_content">
            <div> ${this.message}  </div>  
              <button 
                type="button" 
                id="${this._uuid}_buttonOk" 
                class="uiConfirmBtnOk">
                  Ok
              </button>

              <button 
                type="button" 
                id="${this._uuid}_buttonCancel" 
                class="uiConfirmBtnCancel">
                  Cancel
              </button> 
            </div>
          </div>    
        </div>
      `;
  }

  Init() {
    this._mainDiv = document.getElementById(`${this._uuid}_main`);
    this._buttonOk = document.getElementById(`${this._uuid}_buttonOk`);
    this._buttonCancel = document.getElementById(`${this._uuid}_buttonCancel`);
    this._buttonModal = document.getElementById(`${this._uuid}_buttonModal`);
    this._confirmBox = document.getElementById(`${this._uuid}_confirmBox`);

    // Event handling
    let o = this;
    this._buttonModal.addEventListener("click", function () {
      o._confirmBox.style.display = "block";
    });

    this._buttonCancel.addEventListener("click", function () {
      o._confirmBox.style.display = "none";
    });

    this._buttonOk.addEventListener("click", function () {
      o.dispatch("click", o);
      o._confirmBox.style.display = "none";
    });
  }

  Update(propertyName) {
    switch (propertyName) {
      case "helpText": {
        this._buttonModal.title = this.helpText;
        break;
      }
      case "displayName": {
        this._buttonModal.innerHTML = this.displayName;
        break;
      }
    }
  }
}
