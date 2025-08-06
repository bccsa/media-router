import Gst from '@girs/node-gst-1.0';
import GstWebRTC from '@girs/node-gstwebrtc-1.0';
import GstSdp from '@girs/node-gstsdp-1.0';

/**
 * Helper function to emit a GStreamer signal with a promise
 * @param element - The GStreamer element to emit the signal on
 * @param signalName - The signal name to emit (e.g., 'create-answer', 'set-remote-description')
 * @param signalData - The data to pass with the signal (can be null for signals that don't need data)
 * @param timeout - Timeout in milliseconds (default: 10000ms)
 * @returns Promise that resolves with the GStreamer promise reply data. An "interrupt" method is also added to the promise to allow interrupting the GStreamer promise.
 */
export function gstPromisifySignal(
    element: Gst.Element,
    signalName: string,
    signalData: any = null,
    options: { timeout?: number; waitForResult?: boolean } = {
        timeout: 10000,
        waitForResult: true,
    }
): Promise<Gst.Promise> {
    let gstPromise: Gst.Promise;

    const abortController = new AbortController();
    const abortSignal = abortController.signal;

    const promise = new Promise<Gst.Promise>((resolve, reject) => {
        let isResolved = false;
        let timeoutId: NodeJS.Timeout;

        // Create GStreamer promise
        gstPromise = Gst.Promise.new();

        // Set up timeout
        timeoutId = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                console.error(`❌ GStreamer promise timeout for signal '${signalName}'`);
                reject(new Error(`Timeout waiting for GStreamer promise: ${signalName}`));
            }
        }, options.timeout);

        try {
            // Emit the signal with the promise
            if (signalData !== null) {
                element.emit(signalName, signalData, gstPromise);
            } else {
                element.emit(signalName, gstPromise);
            }

            if (options.waitForResult) {
                // Wait for the promise to complete
                const result = gstPromise.wait();

                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeoutId);

                    if (result === Gst.PromiseResult.REPLIED) {
                        resolve(gstPromise);
                    } else {
                        console.error(
                            `❌ GStreamer promise failed for signal '${signalName}', result: ${result}`
                        );
                        reject(
                            new Error(`GStreamer promise failed: ${signalName}, result: ${result}`)
                        );
                    }
                }
            } else {
                clearTimeout(timeoutId);
                gstPromise.interrupt();
                resolve(gstPromise);
            }
        } catch (error) {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(timeoutId);
                console.error(`❌ Error emitting GStreamer signal '${signalName}':`, error);
                reject(error);
            }
        }

        // Handle abort signal
        abortSignal.addEventListener(
            'abort',
            () => {
                resolve(gstPromise);
            },
            { once: true }
        );
    });

    return promise;
}

/**
 * Specialized helper for WebRTC set-remote-description
 */
export function gstSetRemoteDescription(
    webrtcElement: Gst.Element,
    sdpOffer: string,
    timeout: number = 5000
) {
    const [res, msg] = GstSdp.sdpMessageNewFromText(sdpOffer);
    if (res !== GstSdp.SDPResult.OK) {
        throw new Error(`Parsing SDP failed: ${res}`);
    }

    const offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, msg);
    return gstPromisifySignal(webrtcElement, 'set-remote-description', offer, {
        timeout,
        waitForResult: true,
    });
}

/**
 * Specialized helper for WebRTC create-answer
 */
export async function gstCreateAnswer(webrtcElement: Gst.Element, timeout: number = 5000) {
    const options = Gst.Structure.newEmpty('application/x-gst-webrtc-answer-options');
    const res = await gstPromisifySignal(webrtcElement, 'create-answer', options, {
        timeout,
        waitForResult: true,
    });
    const reply = res.getReply();

    if (!reply) {
        console.error('❌ No reply received from create-answer');
        return null;
    }

    return reply.getValue('answer')?.getBoxed() || null;
}

/**
 * Specialized helper for WebRTC set-local-description
 */
export function gstSetLocalDescription(
    webrtcElement: Gst.Element,
    sessionDescription: any,
    timeout: number = 5000
) {
    return gstPromisifySignal(webrtcElement, 'set-local-description', sessionDescription, {
        timeout,
        waitForResult: false,
    });
}

/**
 * Helper function to set an ICE candidate on a WebRTC element
 * @param webrtcElement
 * @param num - sequence number of the candidate
 * @param candidate - the ICE candidate string
 * @param timeout
 * @returns
 */
export function gstSetIceCandidate(webrtcElement: Gst.Element, num: number, candidate: string) {
    webrtcElement.emit('add-ice-candidate', num, candidate);
}

export async function gstGetTransceivers(webrtcElement: Gst.Element, timeout: number = 5000) {
    // let data;
    // webrtcElement.on('get-transceivers', () => {
    //     data = webrtcElement.Tran
    // });
    // return data;
}

// /**
//  * Specialized helper for WebRTC create-offer
//  */
// export function gstCreateOffer(
//   webrtcElement: Gst.Element,
//   options: Gst.Structure | null = null,
//   timeout: number = 5000
// ) {
//   return gstPromisifySignal(webrtcElement, 'create-offer', options, { timeout, waitForResult: true });
// }

// /**
//  * Extract session description from GStreamer promise reply
//  */
// export function gstExtractSessionDescription(reply: Gst.Structure, key: string = 'answer'): any | null {
//   try {
//     const sessionDesc = reply.getValue(key);
//     if (sessionDesc && sessionDesc.data && sessionDesc.data[0]) {
//       return sessionDesc.data[0];
//     }
//     return sessionDesc;
//   } catch (error) {
//     console.error(`❌ Error extracting session description with key '${key}':`, error);
//     return null;
//   }
// }

// /**
//  * Get SDP text from session description
//  */
// export function gstGetSdpText(sessionDescription: any): string | null {
//   try {
//     if (sessionDescription && sessionDescription.sdp) {
//       return sessionDescription.sdp.asText();
//     }
//     return null;
//   } catch (error) {
//     console.error('❌ Error getting SDP text:', error);
//     return null;
//   }
// }
