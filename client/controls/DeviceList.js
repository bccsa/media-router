class DeviceList extends ui {
    constructor() {
        super();
        this.description = "";
        this.autoStart = false;
        this.autoStartDelay = 500;  // milliseconds
        this._controlsDiv = undefined;
    }

    
    
    get html() {
        return `
        <!-- ${this.name} -->

        <!-- Main Card Container -->
        <div class="drop-shadow-2xl m-2 p-2 w-auto overflow-hidden bg-white rounded-lg text-black border-solid border border-b-[#75C4EB]">

            <details class="rounded group">
                <summary class="list-none flex items-center cursor-pointer
                    focus-visible:outline-none focus-visible:ring focus-visible:ring-pink-500
                    rounded group-open:rounded-b-none group-open:z-[10] relative
                    ">

                    <!-- Top Heading Container  -->
                    <div class="flex flex-row mt-1 mb-1 ml-4 pl-2 w-full h-14">

                            <!-- Name and Volume indicator -->
                            <div class="basis-4/5">
                                <span class="font-semibold text-base" title="Audio Input Name">${this.name}</span>
                            </div>

                            
                            <div class="basis-1/5">
                                <div class="flex flex-row justify-center m-1">

                                    <!-- Toggle On/Off  -->
                                    <div class="basis-1/3">
                                    
                                        <div class="flex">
                                        <label class="form-check-label1 inline-block text-gray-800 mr-2" for="flexSwitchCheckChecked">Off</label>
                                            <div class="form-check form-switch">
                                                
                                                <input class="form-check-input appearance-none w-9 -ml-10 rounded-full float-left h-5 align-top bg-white bg-no-repeat bg-contain bg-gray-300 focus:outline-none cursor-pointer shadow-sm" type="checkbox" role="switch" id="flexSwitchCheckChecked" checked>
                                                <label class="form-check-label2 inline-block text-gray-800" for="flexSwitchCheckChecked">On</label>
                                            </div>
                                        </div>
                                        
                                    </div>

                                    <!-- Settings button  -->
                                    <div class="basis-1/3">
                                        
                                            <button type="button" class="ml-4 bg-cog_solid inline-block rounded-full text-white leading-normal uppercase hover:shadow-lg hover:outline-none hover:ring-0 transition duration-150 ease-in-out w-9 h-9">
                                            </button>
                                    </div>

                                    <!-- Container toggle -->
                                    <div class="basis-1/3 justify-end">
                                        <div class="flex items-start justify-end">
                                            <div class="border-8 border-transparent border-l-black ml-4 mt-1
                                            group-open:rotate-90 transition-transform origin-left
                                            "></div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                    </div>
                </summary>

                <!-- Divider line  -->
                <div class="w-full h-[0.01rem] bg-[#DADBDC]"></div>

                <!-- More Info Container  -->
                <div class="p-6 pt-2 w-full h-auto">

                    <div id="${this._uuid}_audioInputControls" class="h-auto w-auto"></div>
                    
                    
                </div>  

            </details> 

        </div>`;

    }

    
    Init() {
        this._description = document.getElementById(`${this._uuid}_description`);
        this._controlsDiv = document.getElementById(`${this._uuid}_audioInputControls`);
        

        // //Event subscriptions
        // this._description.addEventListener('change', (e) => {
        //     this.description = this._description.value;
        // });

        // // Handle property changes

        // this.on('description', description => {
        //     this._description.value = description;
        // });
    }
}
    