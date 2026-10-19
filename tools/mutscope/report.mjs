function mutantIdentity(file, mutant) {
  const { start, end } = mutant.location ?? {};
  return [file, start?.line, start?.column, end?.line, end?.column,
    mutant.mutatorName, mutant.replacement].join("|");
}

function reportMutants(report) {
  return Object.entries(report?.files ?? {}).flatMap(([file, value]) =>
    (value.mutants ?? []).map((mutant) => ({ file, mutant, source: value.source, language: value.language })));
}

function testIdentity(file, test) {
  return `${file}\0${test.name}`;
}

function unique(values) {
  return [...new Set(values)];
}

export function mergeMutationReports(runs = []) {
  const first = runs.find((run) => run.report)?.report ?? {};
  const testIds = new Map();
  const tests = [];
  const localTestMaps = new Map();

  for (const [runIndex, run] of runs.entries()) {
    const local = new Map();
    for (const [file, value] of Object.entries(run.report?.testFiles ?? {})) {
      for (const test of value.tests ?? []) {
        const identity = testIdentity(file, test);
        if (!testIds.has(identity)) {
          const id = String(testIds.size);
          testIds.set(identity, id);
          tests.push({ file, source: value.source, test: { ...test, id } });
        }
        local.set(String(test.id), testIds.get(identity));
      }
    }
    localTestMaps.set(runIndex, local);
  }

  const accumulated = new Map();
  for (const [runIndex, run] of runs.entries()) {
    const idMap = localTestMaps.get(runIndex);
    const entries = reportMutants(run.report);
    for (const entry of entries) {
      const identity = mutantIdentity(entry.file, entry.mutant);
      const previous = accumulated.get(identity);
      const translate = (ids = []) => ids.map((id) => idMap.get(String(id))).filter((id) => id !== undefined);
      const duration = entry.mutant.duration ?? null;
      const next = {
        ...(previous?.mutant ?? {}),
        ...entry.mutant,
        level: run.level,
        coveredBy: unique([...(previous?.mutant.coveredBy ?? []), ...translate(entry.mutant.coveredBy)]),
        durationMsByLevel: {
          ...(previous?.mutant.durationMsByLevel ?? {}),
          [run.level]: duration,
        },
      };
      if (previous?.mutant.killedBy || entry.mutant.killedBy) {
        next.killedBy = unique([...(previous?.mutant.killedBy ?? []), ...translate(entry.mutant.killedBy)]);
      }
      accumulated.set(identity, { ...entry, mutant: next });
    }
  }

  const files = {};
  for (const entry of accumulated.values()) {
    files[entry.file] ??= {
      language: entry.language,
      mutants: [],
      source: entry.source,
    };
    files[entry.file].mutants.push(entry.mutant);
  }
  const testFiles = {};
  for (const { file, source, test } of tests) {
    testFiles[file] ??= { tests: [], source };
    testFiles[file].tests.push(test);
  }

  const levelTimings = new Map();
  for (const run of runs) {
    const timing = levelTimings.get(run.level) ?? {
      level: run.level,
      durationMs: 0,
      tests: [],
      mutants: 0,
    };
    timing.durationMs += run.durationMs ?? 0;
    timing.tests = unique([...timing.tests, ...(run.tests ?? [])]);
    timing.mutants += reportMutants(run.report).length;
    levelTimings.set(run.level, timing);
  }

  return {
    ...first,
    files,
    testFiles,
    mutscope: {
      levels: [...levelTimings.values()],
    },
  };
}

export function mutationEntries(report) {
  return reportMutants(report);
}

export function mutationIdentity(file, mutant) {
  return mutantIdentity(file, mutant);
}

