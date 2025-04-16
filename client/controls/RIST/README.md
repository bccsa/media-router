# SrtToRist / RistToSrt

This tool facilitates the conversion of SRT traffic to RIST or RIST traffic to SRT.

## RIST Global Settings

-   **UDP Socket Port**: The UDP port used for IPC between GStreamer and RIST tools. This port must be unique and not in use elsewhere.
-   **Buffer (ms)**: Configurable buffer size ranging from 50 ms to 30 seconds.
-   **Add Link**: Allows adding one or more RIST links.

## RIST Link Settings

-   **CNAME**: Identifier for the link on the sender side.
-   **Host**: IP address or hostname of the sender/receiver.
-   **Mode**: Specifies whether the link is in Caller or Listener mode.
-   **Port**: UDP port used for the link.
-   **Buffer Min**: Minimum buffer size for the link.
-   **Buffer Max**: Maximum buffer size for the link.
-   **Weight**: Determines the priority of the link. A higher value means more data will be sent over that link. Use `0` for all links to broadcast traffic equally.
