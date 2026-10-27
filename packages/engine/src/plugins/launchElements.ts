// The named elements of one factory in a launch string, with their properties as written: the
// configuration an element's messages do not carry (house-clock WI-P3-6).

const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^\s!"]+`;

/** Each `<factory> name=… prop=…` up to the next `!`, by its `name=`; quotes taken off. */
export function launchElements(
    pipeline: string,
    factory: string,
): Map<string, Record<string, string>> {
    const out = new Map<string, Record<string, string>>();
    const element = new RegExp(
        String.raw`(?:^|[\s!(])${factory}((?:\s+[\w-]+=(?:${VALUE}))*)`,
        'g',
    );
    for (const m of pipeline.matchAll(element)) {
        const props: Record<string, string> = {};
        for (const p of m[1].matchAll(new RegExp(String.raw`([\w-]+)=(${VALUE})`, 'g'))) {
            props[p[1]] = p[2].startsWith('"') ? p[2].slice(1, -1).replace(/\\(.)/g, '$1') : p[2];
        }
        if (props.name) out.set(props.name, props);
    }
    return out;
}
