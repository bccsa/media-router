// // =====================================
// // Expander label and helptext
// // user control
// //
// // Copyright BCC South Africa
// // =====================================

// // -------------------------------------
// // Class declaration
// // -------------------------------------

// class uiExpander extends _uiControl {
//     constructor() {
//       super();
//       this.displayName = "new control";         // Display name
//       this.helpText = "new control help text";
//       this.margin = "10px";
//       this.padding = "10px";
//       this.deviceName = "New Device"
//       this.autoStart = false;
//       this._c_deviceName = new uiTextBox();
//       this._c_autoStart = new uiCheckbox();

//       // Set static controls values
//       this._c_deviceName.displayName = "Device Name"
//       this._c_autoStart
//     }
  
//     // -------------------------------------
//     // Getters & setters
//     // -------------------------------------
  
//     get html() {
//       return `
//         <!-- ${this.name} --> 
//         <div id="${this._uuid}_main" style="margin:${this.margin}">
//             <div id="${this._uuid}_topBar" style="background-color:grey; width:100%;">
//                 <span id="${this._uuid}_label">${this.displayName}<span>
//             </div>
//             <div id="${this._uuid}_controls" style="padding:${this.padding}; background-color:red; width:100%; display:none;"></div>
//         </div>`;
//     }
  
//     DomLinkup() {
//       this._mainDiv = document.getElementById(`${this._uuid}_main`);
//       this._label = document.getElementById(`${this._uuid}_label`);
//       this._topBar = document.getElementById(`${this._uuid}_topBar`);

//       // this._controlsDiv = document.getElementById(`${this._uuid}_controls`);
  
//       let o = this;
//       this._topBar.addEventListener('dblclick', function(){
//           if (o._controlsDiv.style.display != "block") {
//             o._controlsDiv.style.display = "block"
//           }
//           else {
//             o._controlsDiv.style.display = "none"
//           }
//       });
//     }
  
//     DomUpdate(propertyName) {
//       switch (propertyName) {
//         case "displayName": {
//           this._label.innerText = this.displayName;
//           break;
//         }
//       }
//     }
//   }
  
  