// Configuration
const MAX_PACKET_SIZE = 1412; // Safe size to avoid IP fragmentation

/**
 * Class to handle message fragmentation
 */
class messageFragmentation {
    /**
     * Constructor
     * @param {Object} server - dgram server
     * @param {Object} event - events object
     */
    constructor(server, messageHandler) {
        this.server = server;
        this.messageHandler = messageHandler;
        this.fragments = new Map();

        this.server.on("message", (msg, rinfo) => {
            if (!messageHandler) return;
            // Parse header (e.g., "12345:0:3:actualdata")
            const msgString = msg.toString();
            const headerMatch = msgString.match(/^(\d+):(\d+):(\d+):/);
            if (!headerMatch) {
                console.error("Invalid header format:", msgString);
                return;
            }

            const [_, messageId, fragmentIndex, totalFragments] =
                headerMatch.map(Number);
            const data = Buffer.from(msgString.slice(headerMatch[0].length)); // Strip header

            // Store fragment
            if (!this.fragments.has(messageId)) {
                this.fragments.set(messageId, {
                    fragments: new Array(totalFragments),
                    received: 0,
                    timer: setTimeout(() => {
                        this.fragments.delete(messageId);
                        console.error(`Message ${messageId} timed out and was deleted.`);
                    }, 2000) // 2 seconds timeout
                });
            }

            const messageData = this.fragments.get(messageId);
            if (!messageData.fragments[fragmentIndex]) {
                // Avoid overwriting
                messageData.fragments[fragmentIndex] = data;
                messageData.received++;
            }

            // Check if all fragments are received
            if (messageData.received === totalFragments) {
                clearTimeout(messageData.timer); // Clear the timeout
                const fullMessage = Buffer.concat(
                    messageData.fragments
                ).toString();
                this.messageHandler(fullMessage, rinfo);
                this.fragments.delete(messageId); // Clean up
            }
        });
    }

    /**
     * Send a fragmented message
     * @param {string} message - message to send
     * @param {number} port - destination port
     * @param {string} host - destination host
     */
    sendFragmentedMessage(message, port, host) {
        const messageBuffer = Buffer.from(message);
        const messageId = Math.floor(Math.random() * 1000000); // Unique ID
        const totalFragments = Math.ceil(
            messageBuffer.length / MAX_PACKET_SIZE
        );

        for (let i = 0; i < totalFragments; i++) {
            const offset = i * MAX_PACKET_SIZE;
            const chunk = messageBuffer.slice(offset, offset + MAX_PACKET_SIZE);

            // Create header: messageId:fragmentIndex:totalFragments
            const header = Buffer.from(`${messageId}:${i}:${totalFragments}:`);
            const packet = Buffer.concat([header, chunk]);

            this.server.send(packet, port, host, (err) => {
                if (err) console.error("Error sending fragment:", err);
            });
        }
    }
}

module.exports = messageFragmentation;
