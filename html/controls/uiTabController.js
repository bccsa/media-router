// =====================================
// button with value
// user control
//
// Copyright BCC South Africa
// =====================================

// -------------------------------------
// Class declaration
// -------------------------------------

class uiTabController extends _uiControl {
  constructor() {
    super();
    this.console = document.getElementById(`${this._uuid}_console`);
    this._styles.push("controls/css/bootstrap.min.css");
    this._styles.push("controls/css/uiTabController.css");

    this.SetData({
      list: {
        controlType: "uiList",
        name: "list1",
        displayName: "list.png",
        parentElement: "_tabButtons",
      },
      list2: {
        controlType: "uiList",
        name: "list2",
        displayName: "settings.png",
        parentElement: "_tabButtons",
      },
      tabPage: {
        controlType: "uiTabPage",
        name: "tabPage",
        parentElement: "_tabPages",
      },
    });
  }

  // -------------------------------------
  // Getters & setters
  // -------------------------------------

  get html() {
    return `
      <!-- ${this.name} --> 
      <div id="${this._uuid}_main" class="tabControl">

        <div id="${this._uuid}_tabPages" class="tabPages"> 
        </div>

        <div class="uiTabController">
          <ul id="${this._uuid}_tabButtons">
            
          </ul>
        </div>
          
      </div
                 
      `;
  }

  Init() {
    this._tabPages = document.getElementById(`${this._uuid}_tabPages`);
    this._tabButtons = document.getElementById(`${this._uuid}_tabButtons`);

    this._list01 = document.getElementById(`${this._uuid}_list1`);

    let o = this;
    // this._list01.addEventListener("click", function () {
    //   console.log("o.console");
    // });

    // this._list2.addEventListener("click", function () {
    //   console.log("first");
    // });
  }

  Update(propertyName) {
    switch (propertyName) {
      case "logText": {
        this._eventLog.innerHTML += this.logText;
        break;
      }
    }
  }
}
