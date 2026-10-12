export function wavesOf<T>(ids: T[], edges: { from: T; to: T }[]): Map<T, number> {
    const inside = new Set(ids);
    const preds = new Map<T, T[]>();
    for (const id of ids) preds.set(id, []);
    for (const e of edges) {
        if (!inside.has(e.from) || !inside.has(e.to)) continue;
        preds.get(e.to)!.push(e.from);
    }
    const level = new Map<T, number>();
    const visiting = new Set<T>();
    const walk = (id: T): number => {
        const known = level.get(id);
        if (known !== undefined) return known;
        if (visiting.has(id)) return 1;
        visiting.add(id);
        let best = 1;
        for (const p of preds.get(id) ?? []) best = Math.max(best, walk(p) + 1);
        visiting.delete(id);
        level.set(id, best);
        return best;
    };
    for (const id of ids) walk(id);
    return level;
}
