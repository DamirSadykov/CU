import type { RunGraphNode } from "../../board/graphModel";
import { isDone, laneTotals, moneyOf, type Money } from "./adapt";
import { diffLines, diffStat } from "../../kernel/specDiff";
import { formatRef } from "../../../scripts/cli/kernel/terms.mjs";

export interface ChangeSpecAnswer {
    address: string;
    verdict: string;
    note: string;
    at: string;
    blocks?: string[];
    after?: string;
}

export interface ChangeSpecSeen {
    address: string;
    hash: string;
    blocks: string[];
    text: string;
    at: string;
}

export interface ChangeStatusEvent {
    status: string;
    at: string;
}

export interface ChangeTask {
    id: string;
    number?: number;
    subject: string;
    status: string;
    kind?: string;
    change_id?: string;
    project?: string | null;
    spec?: string[];
    spec_answers?: ChangeSpecAnswer[];
    spec_seen?: ChangeSpecSeen[];
    outcome?: string;
    outcome_reason?: string;
    outcome_at?: string;
    retry_limit?: number;
    handoff_at?: string;
    status_history?: ChangeStatusEvent[];
    created_at?: string;
    updated_at?: string;
}

export interface ChangeRecord {
    id: string;
    number: number;
    title: string;
    delta?: string;
    project?: string | null;
    spec?: string[];
    budget_usd?: number;
    parallel_limit?: number;
    created_at?: string;
    updated_at?: string;
    closed_at?: string;
}

export function changeAddress(change: ChangeRecord): string {
    return formatRef(change);
}

export function changeMembers(board: ChangeTask[], change: ChangeRecord): ChangeTask[] {
    return board
        .filter((t) => t.change_id === change.id)
        .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

export function changeProgress(members: ChangeTask[]): { total: number; done: number } {
    return { total: members.length, done: members.filter((t) => isDone(t.status)).length };
}

export function changeIsOpen(members: ChangeTask[]): boolean {
    const { total, done } = changeProgress(members);
    return !(total > 0 && done === total);
}

export function specAddressesOf(change: ChangeRecord, members: ChangeTask[]): string[] {
    const out = new Set<string>();
    for (const a of change.spec ?? []) out.add(a);
    for (const t of members) for (const a of t.spec ?? []) out.add(a);
    return [...out];
}

export function openChangesAt(
    address: string,
    changes: ChangeRecord[],
    board: ChangeTask[],
): ChangeRecord[] {
    return changes.filter(
        (c) => (c.spec ?? []).includes(address) && changeIsOpen(changeMembers(board, c)),
    );
}

export function attemptsOf(t: ChangeTask): number {
    return (t.status_history ?? []).filter((h) => h.status === "in_progress").length;
}

export type BlockerRule =
    | "spec-answer-missing"
    | "concurrent-change"
    | "task-outcome-issue"
    | "retry-exhausted"
    | "spec-silently-behind";

export interface ChangeBlocker {
    id: string;
    rule: BlockerRule;
    title: string;
    detail: string;
    taskNumber?: number;
    address?: string;
}

export function blockersFor(
    change: ChangeRecord,
    members: ChangeTask[],
    changes: ChangeRecord[],
    board: ChangeTask[],
): ChangeBlocker[] {
    const out: ChangeBlocker[] = [];

    for (const t of members) {
        if (!isDone(t.status)) continue;
        for (const address of t.spec ?? []) {
            const answered = (t.spec_answers ?? []).some((a) => a.address === address);
            if (answered) continue;
            out.push({
                id: `spec-answer-missing:${t.id}:${address}`,
                rule: "spec-answer-missing",
                title: `#${t.number} закрыта без ответа на ${address}`,
                detail: t.subject,
                taskNumber: t.number,
                address,
            });
        }
    }

    for (const address of specAddressesOf(change, members)) {
        const open = openChangesAt(address, changes, board);
        if (open.length < 2) continue;
        const others = open.filter((c) => c.id !== change.id);
        if (!others.length) continue;
        out.push({
            id: `concurrent-change:${address}`,
            rule: "concurrent-change",
            title: `${address}: открытых планов одновременно — ${open.length}`,
            detail: others.map((c) => `${changeAddress(c)} "${c.title}"`).join(", "),
            address,
        });
    }

    for (const t of members) {
        if (t.outcome === "issue") {
            out.push({
                id: `task-outcome-issue:${t.id}`,
                rule: "task-outcome-issue",
                title: `#${t.number} завершилась с issue`,
                detail: t.outcome_reason || t.subject,
                taskNumber: t.number,
            });
        }
        if (
            typeof t.retry_limit === "number" &&
            t.status !== "done" &&
            attemptsOf(t) > t.retry_limit
        ) {
            out.push({
                id: `retry-exhausted:${t.id}`,
                rule: "retry-exhausted",
                title: `#${t.number} исчерпала лимит попыток (${attemptsOf(t)}/${t.retry_limit})`,
                detail: t.subject,
                taskNumber: t.number,
            });
        }
    }

    const addresses = specAddressesOf(change, members);
    if (!addresses.length && members.some((t) => isDone(t.status)) && changeIsOpen(members)) {
        out.push({
            id: `spec-silently-behind:${change.id}`,
            rule: "spec-silently-behind",
            title: "план открыт без ссылки на спеку",
            detail: `${members.filter((t) => isDone(t.status)).length} задач(и) уже закрыты, а раздел спеки не указан ни в плане, ни в его задачах`,
        });
    }

    return out;
}

export interface ChangeWaiting {
    id: string;
    taskNumber?: number;
    subject: string;
    gate: boolean;
    note: string;
}

export function waitingFor(members: ChangeTask[]): ChangeWaiting[] {
    return members
        .filter((t) => t.status === "review")
        .map((t) => ({
            id: t.id,
            taskNumber: t.number,
            subject: t.subject,
            gate: (t.kind ?? "") !== "auto",
            note: (t.kind ?? "") !== "auto" ? "ручной гейт" : "в review",
        }));
}

export interface ChangeCheck {
    id: string;
    label: string;
}

export function passedFor(
    change: ChangeRecord,
    members: ChangeTask[],
    blockers: ChangeBlocker[],
    nodes: RunGraphNode[],
): ChangeCheck[] {
    const out: ChangeCheck[] = [];
    const addresses = specAddressesOf(change, members);
    if (addresses.length && !blockers.some((b) => b.rule === "spec-answer-missing")) {
        out.push({ id: "spec-answered", label: "все ссылки на спеку отвечены" });
    }
    if (addresses.length && !blockers.some((b) => b.rule === "concurrent-change")) {
        out.push({ id: "no-concurrent", label: "ни один раздел не делят два открытых плана" });
    }
    if (
        members.length &&
        !blockers.some((b) => b.rule === "task-outcome-issue" || b.rule === "retry-exhausted")
    ) {
        out.push({ id: "no-issues", label: "ни одна задача не завершилась issue" });
    }
    const measured = nodes.filter((n) => n.measurability === "measured");
    if (measured.length) {
        const errors = measured.reduce((sum, n) => sum + (n.tool_errors ?? 0), 0);
        if (errors === 0) out.push({ id: "no-tool-errors", label: "все прогоны без ошибок инструментов" });
    }
    return out;
}

export interface SpecSummaryTaskRow {
    taskNumber?: number;
    status: string;
    verdict?: string;
}

export interface SpecSummaryRow {
    address: string;
    tasks: SpecSummaryTaskRow[];
    added: number;
    removed: number;
    concurrent: boolean;
    openOthers: string[];
}

function deltaStatOf(t: ChangeTask, address: string): { added: number; removed: number } | null {
    const seen = (t.spec_seen ?? []).find((s) => s.address === address);
    const answer = (t.spec_answers ?? []).find((a) => a.address === address);
    if (!seen?.text || !answer?.after) return null;
    return diffStat(diffLines(seen.text, answer.after));
}

export function specSummaryFor(
    change: ChangeRecord,
    members: ChangeTask[],
    changes: ChangeRecord[],
    board: ChangeTask[],
): SpecSummaryRow[] {
    return specAddressesOf(change, members).map((address) => {
        const tasks = members
            .filter((t) => (t.spec ?? []).includes(address))
            .map((t) => ({
                taskNumber: t.number,
                status: t.status,
                verdict: (t.spec_answers ?? []).find((a) => a.address === address)?.verdict,
            }));
        let added = 0;
        let removed = 0;
        for (const t of members) {
            const stat = deltaStatOf(t, address);
            if (!stat) continue;
            added += stat.added;
            removed += stat.removed;
        }
        const open = openChangesAt(address, changes, board);
        return {
            address,
            tasks,
            added,
            removed,
            concurrent: open.length >= 2,
            openOthers: open.filter((c) => c.id !== change.id).map((c) => changeAddress(c)),
        };
    });
}

export interface ChangeEvent {
    at: string;
    label: string;
    meta?: string;
}

export function historyFor(change: ChangeRecord, members: ChangeTask[]): ChangeEvent[] {
    const out: ChangeEvent[] = [];
    if (change.created_at) out.push({ at: change.created_at, label: `${changeAddress(change)} создан` });
    if (change.closed_at) out.push({ at: change.closed_at, label: `${changeAddress(change)} закрыт` });
    for (const t of members) {
        const label = (s: string) => `#${t.number} ${s}`;
        for (const h of t.status_history ?? []) {
            if (!h.at) continue;
            out.push({ at: h.at, label: label(`→ ${h.status}`) });
        }
        for (const a of t.spec_answers ?? []) {
            if (!a.at) continue;
            out.push({
                at: a.at,
                label: label(`ответил "${a.verdict}" по ${a.address}`),
                meta: a.note ? a.note.slice(0, 140) : undefined,
            });
        }
        if (t.outcome && t.outcome_at) {
            out.push({
                at: t.outcome_at,
                label: label(`outcome ${t.outcome}${t.outcome_reason ? ` (${t.outcome_reason})` : ""}`),
            });
        }
        if (t.handoff_at) out.push({ at: t.handoff_at, label: label("оставил батон") });
    }
    return out
        .filter((e) => e.at && !Number.isNaN(Date.parse(e.at)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function specEditsCount(members: ChangeTask[]): number {
    return members.reduce(
        (sum, t) => sum + (t.spec_answers ?? []).filter((a) => a.verdict === "updated").length,
        0,
    );
}

export interface ChangeCostRow {
    taskNumber: number;
    subject: string;
    money: Money;
    unattributed: number | null;
}

export interface ChangeCost {
    known: boolean;
    cost: number;
    unattributed: number;
    unknownCount: number;
    measuredCount: number;
    rows: ChangeCostRow[];
}

export function costFor(members: ChangeTask[], nodes: RunGraphNode[]): ChangeCost {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const rows: ChangeCostRow[] = members.map((t) => {
        const node = byId.get(t.id);
        const money: Money = node ? moneyOf(node) : { text: "нет данных", known: false };
        return {
            taskNumber: t.number ?? 0,
            subject: t.subject,
            money,
            unattributed: node?.unattributed_cost ?? null,
        };
    });
    const totals = laneTotals(nodes);
    return {
        known: nodes.length > 0 && totals.unknown < nodes.length,
        cost: totals.cost,
        unattributed: totals.unattributed,
        unknownCount: totals.unknown,
        measuredCount: nodes.filter((n) => n.measurability === "measured").length,
        rows,
    };
}

export function workMinutesFor(members: ChangeTask[], end: number): number {
    const spans: Array<[number, number]> = [];
    for (const t of members) {
        const events = (t.status_history ?? [])
            .map((h) => ({ status: h.status, at: Date.parse(h.at) }))
            .filter((e) => !Number.isNaN(e.at))
            .sort((a, b) => a.at - b.at);
        events.forEach((e, i) => {
            if (e.status !== "in_progress") return;
            const stop = Math.min(events[i + 1]?.at ?? end, end);
            if (stop > e.at) spans.push([e.at, stop]);
        });
    }
    spans.sort((a, b) => a[0] - b[0]);
    let total = 0;
    let from = -Infinity;
    let to = -Infinity;
    for (const [s, e] of spans) {
        if (s > to) {
            if (to > from) total += to - from;
            from = s;
            to = e;
        } else if (e > to) to = e;
    }
    if (to > from) total += to - from;
    return total / 60000;
}

export type WorkUnit = "min" | "h" | "d";

export function workSpan(minutes: number): { value: number; unit: WorkUnit } {
    if (minutes < 60) return { value: Math.max(1, Math.round(minutes)), unit: "min" };
    if (minutes < 24 * 60) return { value: Math.round(minutes / 60), unit: "h" };
    return { value: Math.round(minutes / (24 * 60)), unit: "d" };
}

export function sortedByRecency(changes: ChangeRecord[]): ChangeRecord[] {
    return [...changes].sort((a, b) => {
        const ta = Date.parse(a.created_at ?? "");
        const tb = Date.parse(b.created_at ?? "");
        if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return tb - ta;
        return (b.number ?? 0) - (a.number ?? 0);
    });
}
