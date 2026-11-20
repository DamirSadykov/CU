import type { TodoFacet, TodoView } from "./todoFilter";
import type { DayBucket, RelativeTime, TodoDisplay, TodoSort } from "./taskSort";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface ChoiceLabel {
  label: string;
  hint: string;
  short: string;
}

const capital = (key: string) => key[0].toUpperCase() + key.slice(1);

export function sortLabels(t: Translate): Record<TodoSort, ChoiceLabel> {
  const entry = (key: TodoSort): ChoiceLabel => ({
    label: t(`todoSort${capital(key)}`),
    hint: t(`todoSort${capital(key)}Hint`),
    short: t(`todoSort${capital(key)}Short`),
  });
  return { updated: entry("updated"), created: entry("created"), oldest: entry("oldest"), number: entry("number"), cost: entry("cost") };
}

export function displayLabels(t: Translate): Record<TodoDisplay, Omit<ChoiceLabel, "short">> {
  return {
    tree: { label: t("todoDisplayTree"), hint: t("todoDisplayTreeHint") },
    feed: { label: t("todoDisplayFeed"), hint: t("todoDisplayFeedHint") },
  };
}

export function viewLabels(t: Translate): Record<TodoView, string> {
  return { active: t("todoViewActive"), attention: t("todoViewAttention"), done: t("todoViewDone"), all: t("todoViewAll") };
}

export function facetLabels(t: Translate): Record<TodoFacet, string> {
  return { status: t("todoFacetStatus"), project: t("todoFacetProject"), priority: t("todoFacetPriority"), created: t("todoFacetCreated") };
}

const STATUS_KEYS: Record<string, string> = {
  backlog: "colBacklog", queue: "colQueue", in_progress: "statusInProgress", review: "colReview", done: "statusDone",
};
const PRIORITY_KEYS: Record<string, string> = { high: "todoPriorityHigh", medium: "todoPriorityMedium", low: "todoPriorityLow" };

export function optionLabel(t: Translate, facet: TodoFacet, option: string): string {
  if (facet === "status") return STATUS_KEYS[option] ? t(STATUS_KEYS[option]) : option;
  if (facet === "priority") return PRIORITY_KEYS[option] ? t(PRIORITY_KEYS[option]) : option;
  if (facet === "created") return t(`todoCreated${option}`);
  return option;
}

export function bucketLabel(t: Translate, bucket: DayBucket): string {
  return t(`todoBucket${capital(bucket)}`);
}

export function relativeLabel(t: Translate, time: RelativeTime, locale: string): string {
  if (time.unit === "yesterday") return t("todoAgoYesterday");
  if (time.unit === "date") return time.value.toLocaleDateString(locale, { day: "numeric", month: "short" }).replace(".", "");
  const key = time.unit === "minute" ? "todoAgoMinute" : time.unit === "hour" ? "todoAgoHour" : "todoAgoDay";
  return t(key, { n: time.value });
}
