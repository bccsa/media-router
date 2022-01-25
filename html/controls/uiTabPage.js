// =====================================
// uiTabPage controls
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiTabPage extends _uiControl {
  constructor() {
    super();
    this.name = "";
    this.displayName = "";
    this._styles.push("controls/css/bootstrap.min.css");

    this.SetData({
      eventLog: {
        controlType: "uiEventLog",
        parentElement: "_tapPage",
        name: "eventLog",
      },
    });
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
            <!-- ${this.name} -->
            <div style="width:97%" id="${this._uuid}_main">
                <div id="${this._uuid}_tapPage">
                </div>
            </div>
        `;
  }

  Init() {
    this._tapPage = document.getElementById(`${this._uuid}_tapPage`);
  }
}
