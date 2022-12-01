class AudioInput extends ui {
    constructor() {
        super();
        this.autoStart = false;
        this.autoStartDelay = 500;  // milliseconds
    }
    
    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="ml-4 mt-2 w-[30rem] overflow-hidden bg-[#1E293B] rounded-lg text-white border-solid border-1 border-b-[#75C4EB]">

            <details class="shadow rounded group">
                <summary class="list-none flex items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[10] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="grid grid-cols-3 mt-1 mb-1 ml-4 pl-2 w-full h-14">

                            <!-- Name -->
                            <div class="w-1/3">
                                <span class="font-semibold text-base" title="Audio Input Name">${this.name}</span>

                            </div>

                            <!-- Mute Button -->
                            <div class="ml-[10.5rem] mt-2">
                                <button id="${this._uuid}_control_button" type="button" title="Mute Button" class="h-10 w-20 inline-block px-6 py-2.5 leading-tight
                                    uppercase rounded hover:bg-green-600 hover:shadow-lg focus:bg-green-600 focus:shadow-lg focus:outline-none 
                                    focus:ring-0 transition duration-150 ease-in-out">
                                    <span id="${this._uuid}_control_button_text">OFF</span>
                                </button>
                            </div>

                            <!-- Container toggle -->
                            <div class="w-1/4 flex flex-col items-end ml-28">
                                <div class="flex w-10 items-center justify-center">
                                    <div class="border-8 border-transparent border-l-white mr-1 mt-1
                                    group-open:rotate-90 transition-transform origin-left
                                    "></div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#75C4EB]"></div>

                <!-- More Info Container  -->
                <div class="p-6 pt-2 w-full h-auto">
                    <div id="${this._uuid}_deviceList" class="w-auto h-auto" title="Audio Indicator"></div>
                    
                </div>  

            </details> 

        </div>`;

    }

    
    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
        this._deviceList = document.getElementById(`${this._uuid}_volume_slit`);
        

        //Event subscriptions
        this._description.addEventListener('change', (e) => {
            this.description = this._description.value;
        });

        // Add Controls
        this.SetData({
                AudioInput_SCC_Pulpit:{
                    controlType: "AudioInput",
                    parentElement: _deviceList,
                },
        });

        // Handle property changes

        this.on('description', description => {
            this._description.value = description;
        });
    }
}
    