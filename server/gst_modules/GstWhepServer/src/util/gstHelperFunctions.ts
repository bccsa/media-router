import Gst from "@girs/node-gst-1.0";

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
        const child = parent.getChildByIndex(i) as Gst.Element;
        if (child && child.name && child.name.includes(name)) {
            return child;
        }
    }

    return null;
}
