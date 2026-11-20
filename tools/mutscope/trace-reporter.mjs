import { appendFileSync } from "node:fs";
import { PluginKind, commonTokens, declareClassPlugin } from "@stryker-mutator/api/plugin";

class TraceReporter {
  static inject = [commonTokens.options];

  constructor(options) {
    this.file = options.mutscopeTrace;
    this.started = performance.now();
    this.write({ event: "created", concurrency: options.concurrency ?? null });
  }

  write(entry) {
    if (!this.file) return;
    appendFileSync(this.file, `${JSON.stringify({ t: Math.round(performance.now() - this.started), ...entry })}\n`);
  }

  onDryRunCompleted({ result, timing }) {
    this.write({
      event: "dryRun",
      net: timing.net,
      overhead: timing.overhead,
      tests: (result.tests ?? []).map((test) => ({
        name: test.name, file: test.fileName ?? null, ms: test.timeSpentMs ?? null,
      })),
    });
  }

  onMutationTestingPlanReady({ mutantPlans }) {
    this.write({
      event: "plan",
      mutants: mutantPlans.map((plan) => ({
        id: plan.mutant.id,
        mutator: plan.mutant.mutatorName,
        line: plan.mutant.location.start.line,
        plan: plan.plan,
        status: plan.plan === "EarlyResult" ? plan.mutant.status : null,
        tests: plan.runOptions?.testFilter?.length ?? null,
        timeoutMs: plan.runOptions?.timeout ?? null,
        netMs: plan.netTime ?? null,
      })),
    });
  }

  onMutantTested(result) {
    this.write({ event: "mutant", id: result.id, status: result.status, killedBy: result.killedBy?.length ?? 0 });
  }

  onMutationTestReportReady() {
    this.write({ event: "report" });
  }

  wrapUp() {
    this.write({ event: "wrapUp" });
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.Reporter, "mutscope-trace", TraceReporter)];
