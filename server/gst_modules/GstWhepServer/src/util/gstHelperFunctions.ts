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
    }

    return null;
}
