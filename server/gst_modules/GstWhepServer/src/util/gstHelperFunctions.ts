const runningAvgSamples = 6; // Number of samples to use for running average

import GObject from "@girs/node-gobject-2.0";
import Gst from "@girs/node-gst-1.0";
import { WhepBin } from "./index";

export type whepBinStats = {
    packetsLost: number;
    rtt: number;
    packetSent: number;
    lastPacketsLoss: number; // used to calculate packets lost running average
    lastPacketsSent: number; // used to calculate packets sent running average
    packetsLostPercent: number;
    missingInbound: number; // Value that is increased every time inbound stats is missing, and clear session if it is missing for too long
};

/**
 * Retrieves a Gst.Element by its name from a Gst.Bin or Gst.Pipeline.
 * If `exactmatch` is true, it will return the element only if the name matches exactly.
 * If `exactmatch` is false, it will return the first element whose name includes the specified name.
 * @param parent - Gst.Bin or Gst.Pipeline to search within
 * @param name - Name of the element to search for
 * @param exactmatch - Whether to match the name exactly or partially
 * @returns The matching Gst.Element or null if not found
 */
export function getElementByName(
    parent: Gst.Bin | Gst.Pipeline,
    name: string,
    exactmatch: boolean = false
): Gst.Element | null {
    if (exactmatch) return parent.getChildByName(name) as Gst.Element;

    const childCount = parent.getChildrenCount();

    for (let i = 0; i < childCount; i++) {
        let bestMatch: Gst.Element | null = null;
        let bestScore = Infinity;

        for (let i = 0; i < childCount; i++) {
            const child = parent.getChildByIndex(i) as Gst.Element;
            if (child && child.name) {
                const distance = levenshteinDistance(name, child.name);
                if (distance < bestScore) {
                    bestScore = distance;
                    bestMatch = child;
                }
            }
        }

        return bestMatch;
    }

    return null;
}

// Helper function to calculate Levenshtein distance
function levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1)
        .fill(null)
        .map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
    for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1,
                matrix[j - 1][i] + 1,
                matrix[j - 1][i - 1] + cost
            );
        }
    }

    return matrix[str2.length][str1.length];
}

/**
 * Retrieves WebRTC statistics from a Gst.Element representing a WebRTC bin.
 * @param webrtc - Gst.Element representing the WebRTC bin
 * @description This function retrieves WebRTC statistics from a Gst.Element representing a WebRTC bin.
 * It emits the "get-stats" signal on the sink pad of the WebRTC element and waits for the reply.
 * The statistics include packets lost, round-trip time (RTT), and packets sent.
 * If the statistics cannot be retrieved, it returns null.
 * @returns
 */
export function getWebrtcBinStats(whepBin: WhepBin): whepBinStats | null {
    const gstPromise = Gst.Promise.new();

    const pad = whepBin.webrtc.getStaticPad("sink_0"); // check event no more pads

    whepBin.webrtc.emit("get-stats", pad, gstPromise);

    gstPromise.wait();

    const result = gstPromise.getReply();
    if (!result) {
        console.error("❌ Failed to get WebRTC stats");
        return null;
    }

    const remoteInbound = getValueByName(
        result,
        "rtp-remote-inbound-stream-stats"
    );
    const localOutbound = getValueByName(result, "rtp-outbound-stream-stats");
    const packetLoss = getValueByName(remoteInbound, "packets-lost");
    const rtt = getValueByName(remoteInbound, "round-trip-time");
    const packetSent = getValueByName(localOutbound, "packets-sent");
    const stats = whepBin.stats;

    if (!stats) {
        return {
            packetsLost: packetLoss ? packetLoss : 0,
            lastPacketsLoss: packetLoss ? packetLoss : 0,
            rtt: rtt ? Math.round(rtt * 1000 * 100) / 100 : 0, // Convert to milliseconds and round to 2 decimal places
            packetSent: packetSent ? packetSent : 0,
            lastPacketsSent: packetSent ? packetSent : 0,
            missingInbound: 0, // Initialize missingInbound to 0
            packetsLostPercent: 0, // Initialize packetsLostPercent to 0
        };
    }

    if (!remoteInbound) stats.missingInbound++;
    else stats.missingInbound = 0; // Reset if inbound stats are found

    stats.packetsLost = calculateRunningAverage(
        stats.packetsLost,
        (packetLoss || stats.lastPacketsLoss) - stats.lastPacketsLoss
    );
    stats.packetSent = calculateRunningAverage(
        stats.packetSent,
        (packetSent || stats.lastPacketsSent) - stats.lastPacketsSent
    );
    stats.rtt =
        Math.round(calculateRunningAverage(stats.rtt, rtt * 1000 * 100)) / 100; // Convert to milliseconds and round to 2 decimal places
    stats.lastPacketsLoss = packetLoss ? packetLoss : stats.lastPacketsLoss;
    stats.lastPacketsSent = packetSent ? packetSent : stats.lastPacketsSent;
    stats.packetsLostPercent =
        Math.round((stats.packetsLost / stats.packetSent) * 10000) / 100;

    return stats;
}

function calculateRunningAverage(
    currentValue: number,
    lastValue: number,
    samples: number = runningAvgSamples
): number {
    if (samples <= 0) return currentValue;

    // Calculate the running average using a simple formula
    return (lastValue * (samples - 1)) / samples + currentValue / samples;
}

/**
 * Get a value by its name from a Gst.Structure.
 * This function searches through the fields of the structure and returns the value
 * associated with the first field that matches the provided name.
 * If no matching field is found, it returns null.
 * @param structure - The Gst.Structure to search within
 * @param name - The name of the field to retrieve
 * @returns The value associated with the field name, or null if not found
 */
function getValueByName(structure: Gst.Structure, name: string): any {
    if (!structure || !name) return null;

    const numFields = structure.nFields();

    for (let i = 0; i < numFields; i++) {
        const fieldName = structure.nthFieldName(i);

        if (fieldName.includes(name))
            return convertGstTypeToValue(structure.getValue(fieldName));
    }

    // If the field is not found, return null
    return null;
}

const convertGstTypeToValue = (value: any): any => {
    if (value === null || value === undefined) return null;

    const type = GObject.typeName(value.gType);

    if (GObject.typeIsA(value.gType, GObject.TYPE_STRING))
        return value.getString();
    if (GObject.typeIsA(value.gType, GObject.TYPE_INT)) return value.getInt();
    if (GObject.typeIsA(value.gType, GObject.TYPE_UINT)) return value.getUint();
    if (GObject.typeIsA(value.gType, GObject.TYPE_INT64))
        return value.getInt64();
    if (GObject.typeIsA(value.gType, GObject.TYPE_UINT64))
        return value.getUint64();
    if (
        GObject.typeIsA(value.gType, GObject.TYPE_DOUBLE) ||
        GObject.typeIsA(value.gType, GObject.TYPE_FLOAT)
    )
        return value.getDouble();
    if (GObject.typeIsA(value.gType, GObject.TYPE_BOOLEAN))
        return value.getBoolean();
    if (type === "GstStructure")
        // Recursively handle nested structures
        return value.getBoxed();
    if (type === "GstWebRTCStatsType") return type;

    // Fallback to string representation for unknown types
    try {
        return value.toString();
    } catch (e) {
        return null;
    }
};

/**
 * Converts a Gst.Structure to a JSON object recursively
 * @param structure - The Gst.Structure to convert
 * @returns A plain JavaScript object representation
 */
export function gstStructureToJson(structure: any): any {
    if (!structure) return null;

    const result: any = {};
    const numFields = structure.nFields();

    for (let i = 0; i < numFields; i++) {
        const fieldName = structure.nthFieldName(i);
        const value = structure.getValue(fieldName);
        const type = GObject.typeName(value.gType);

        if (type === "GstStructure") {
            // Recursively handle nested structures
            result[fieldName] = gstStructureToJson(value.getBoxed());
        } else {
            result[fieldName] = convertGstTypeToValue(value);
        }
    }

    return result;
}
