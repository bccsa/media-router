const controlsDiv = document.getElementById(`controls`);
const domBody = document.getElementById(`body`);
const domHead = document.getElementById(`head`);

const textBox1 = new uiTextBox();
const textBox2 = new uiTextBox(); 
const textBox3 = new uiTextBox();
const textBox4 = new uiTextBox();

const select1 = new uiSelect();

controlsDiv.innerHTML += select1.html;
textBox1.DomLinkup();

controlsDiv.innerHTML += select1.html;
textBox1.DomLinkup();

controlsDiv.innerHTML += select1.html;
textBox1.DomLinkup();

controlsDiv.innerHTML += textBox1.html;
textBox1.DomLinkup();

controlsDiv.innerHTML += textBox3.html;
//textBox3.DomLinkup();

controlsDiv.innerHTML += textBox3.html;
//textBox3.DomLinkup();

controlsDiv.innerHTML += textBox4.html; 


// const textBox2 = new uiTextBox();


//textBox1.AddControl(textBox2);

// Build event chaining to notify parent objects of new CSS and/or Javascript references.
domHead.innerHTML += textBox1.stylesHtml; 