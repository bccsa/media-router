module.exports = {
    ristHtml: () => {
        return `
        <div class="border-t border-gray-600 rounded-b-md mb-2"></div> 

        <div class="w-full items-center justify-items-center justify-center">
            <div class="text-center align-top font-semibold text-base">RIST Settings</div>
        </div>

        <div class="w-full mb-2 flex ">
            <!-- buffer  --> 
            <div class="w-1/3 mr-4 flex flex-col  mb-2">
                <label for="@{_udpSocket}" class="form-label inline-block mb-2 mr-2">UDP socket port:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" max="65535" id="@{_udpSocket}" 
                    title="Actual buffer size" name="Buffer size in ms" step="1" class="srtOpusInput-pos-number-input"
                    value="@{udpSocket}">

            <span id="@{_udpSocketWarning}" class="text-red-600" style="display: none;">
            </div>

            <!-- buffer  --> 
            <div class="w-1/3 mr-4 flex flex-col  mb-2">
                <label for="@{_buffer}" class="form-label inline-block mb-2 mr-2">Buffer (ms):</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_buffer}" 
                    title="Actual buffer size" name="Buffer size in ms" step="1" class="srtOpusInput-pos-number-input"
                    value="@{buffer}">
            </div>

            <!-- place holder  --> 
            <div class="w-1/3 mr-4 flex flex-col">
            </div>

        </div>
        `;
    },

    ristConfigHtml: (type) => {
        return `
        <div class="border-t border-gray-600 rounded-b-md"></div> 


        <!-- CName  --> 
        <div class="w-full mb-2">

            <div class="flex">
                <label for="@{_cname}" class="form-label inline-block mb-2 self-end grow">cname:</label>

                <button id="@{_btnDelete}" class="h-6 w-6 paAudioBase-btn-delete self-center" type="button" data-bs-dismiss="modal"
                title="Delete device"></button>
            </div>
        
            <input id="@{_cname}" class="paAudioBase-text-area" type="text"
            title="Cname used to identify endpoint" placeholder="Your Cname" value="@{cname}"/>
        </div>

        <!-- host  -->
        <div id="@{_hostDiv}" class="w-full mb-2">
            <label for="@{_host}" class="form-label inline-block mb-2">Host:</label>

            <input id="@{_host}" class="paAudioBase-text-area" type="text"
            title="Host name / ip address" placeholder="Your Host" value="@{host}"/>
        </div>

        <div class="w-full mb-2 flex ">
            <!-- mode  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_mode}" class="form-label inline-block mb-2 mr-2">Mode:</label>
                <select id="@{_mode}" title="SRT mode (caller, listener)" value="@{mode}" 
                name="SRT Mode" class="paAudioBase-select" type="text">
                    <option value="caller">Caller</option>
                    <option value="listener">Listener</option>
                </select>
            </div>

            <!-- port  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_port}" class="form-label inline-block mb-2 mr-2">Port:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_port}" 
                    title="Port" name="Port" step="1" class="srtOpusInput-pos-number-input"
                    value="@{port}">
                <span id="@{_portWarning}" class="text-red-600" style="display: none;">
            </div>

            ${
                type == "RistToSrt"
                    ? `
                <!-- buffer  --> 
                <div class="w-1/3 mr-4 flex flex-col">
                    <label for="@{_buffer}" class="form-label inline-block mb-2 mr-2">Latency (ms):</label>
                    <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_buffer}" 
                        title="Latency (ms)" name="Latency ms" step="1" class="srtOpusInput-pos-number-input"
                        value="@{buffer}">
                </div>`
                    : `
                <!-- Place holder  --> 
                <div class="w-1/3 mr-4 flex flex-col">
                </div>`
            }

        </div>

        <div class="w-full mb-2 flex">
            <!-- weight  --> 
            <div class="w-1/3 mr-4 flex flex-col">
                <label for="@{_weight}" class="form-label inline-block mb-2 mr-2">Weight:</label>
                <input type="number" min="0" oninput="validity.valid||(value='')" id="@{_weight}" 
                    title="Link weight, use 0 to broadcast traffic over both links, the bigger the weight, the more data will be sent over the link" name="Link weight" step="1" class="srtOpusInput-pos-number-input"
                    value="@{weight}">
            </div>

            <!-- Place holder  --> 
            <div class="w-1/3 mr-4 flex flex-col">
            </div>

            <!-- Place holder  --> 
            <div class="w-1/3 mr-4 flex flex-col">
            </div>

        </div>
        `;
    },

    ristStatsHtml: () => {
        return `
        <!--  Rist Stats section  -->
        <div class="paAudioBase-modal-header">
            <div class="flex flex-shrink-0 items-center justify-between">
                <span class="appFrame-control-name">RIST Stats</span>
            </div>
        </div>

        <div class="paAudioBase-modal-body">
            <div id="@{_modalSrtStats_table_cols}">
                <!-- RIST Controls div -->
                <div class="text-sm text-left grid grid-cols-6">
                    <div class="border px-4 py-2">
                        ID
                    </div>
                    <div class="border px-4 py-2">
                        CName
                    </div>
                    <div class="border px-4 py-2">
                        Send/ Receive Rate (MBPS)
                    </div>
                    <div class="border px-4 py-2">
                        Quality
                    </div>
                    <div class="border px-4 py-2">
                        Roundtrip time (ms)
                    </div>
                    <div class="border px-4 py-2">
                        Status
                    </div>
                </div>
                <div id="@{_RistStatsDiv}"></div>
            </div>
        </div>
        `;
    },
};
