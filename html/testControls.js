const controlsDiv = document.getElementById(`controls`);
// const domBody = document.getElementById(`body`);
const domHead = document.getElementsByTagName(`head`)[0];

let _abortController = new AbortController();
document.addEventListener('DOMContentLoaded', _init, { signal: _abortController.signal } );
// window.addEventListener('load', _init(), { signal: _abortController.signal } );

// Control initialization
function _init() {
    _abortController.abort();
    

    const textBox1 = new uiTextBox();

    textBox1.displayName = "Hallo";
    controlsDiv.innerHTML += textBox1.html;

    // textBox1.DomLinkup();
    // textBox1.styles.forEach(ref => {
    //     domHead.innerHTML += `<link rel="stylesheet" href="${ref}"></link>`;
    // })

    // Child controls
    // const textBox2 = new uiTextBox();
    // textBox2.value = "Hallo Etienne";
    // textBox1.AddControl(textBox2);
}

// Top level parent control

// 



