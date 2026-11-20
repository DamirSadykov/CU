<script setup lang="ts">
import { ref, watch } from "vue";
import CuSeg from "../kernel/ui/CuSeg.vue";
import CuToggle from "../kernel/ui/CuToggle.vue";
import type { CuSegOption } from "../kernel/ui/types";
import { THEME_IDS, applyTheme, readCachedTheme, type ThemeId } from "../kernel/theme";
import { formatRef } from "../../scripts/cli/kernel/terms.mjs";

const THEME_LABELS: Record<ThemeId, string> = {
  light: "Светлая",
  dark: "Тёмная",
  acid: "Кислотная",
  "acid-dark": "Кислотная тёмная",
  ultraviolet: "Ультрафиолет",
};

const themeOptions: CuSegOption<ThemeId>[] = THEME_IDS.map((id) => ({ value: id, label: THEME_LABELS[id] }));
const theme = ref<ThemeId>(readCachedTheme() ?? "light");
watch(theme, (id) => applyTheme(id));

const view = ref<"tree" | "waves" | "trace">("tree");
const viewOptions: CuSegOption<"tree" | "waves" | "trace">[] = [
  { value: "tree", label: "Дерево" },
  { value: "waves", label: "Волны" },
  { value: "trace", label: "Трасса", disabled: true },
];
const route = ref(true);
const hideDone = ref(false);
const costs = ref(true);

const surfaces = ["--ink-0", "--ink-1", "--ink-2", "--ink-3", "--ink-4", "--field", "--bold", "--paper", "--paper-2", "--paper-3", "--paper-4"];
const signals = ["--hemp", "--hemp-2", "--next", "--ok", "--warn", "--crit", "--hazard"];
const agents = ["--ag-claude", "--ag-codex", "--ag-gemini"];
const statuses = [
  { cls: "queued", label: "в очереди" },
  { cls: "running", label: "в работе" },
  { cls: "review", label: "ревью" },
  { cls: "done", label: "готово" },
  { cls: "blocked", label: "блок" },
];
const tree = [
  { kind: "change", id: formatRef(66), name: "Дерево работы сессий", d: 0, st: "running", cost: "9.59", agent: "claude" },
  { kind: "done", id: "#803", name: "Разбор транскрипта Claude Code", d: 1, st: "done", cost: "0.86" },
  { kind: "done", id: "#805", name: "get_task_work_tree с кэшем", d: 1, st: "done", cost: "1.59" },
  { kind: "sel", id: "#812", name: "Контекст старта сессий", d: 1, st: "running", cost: "1.23", tag: "route" },
  { kind: "", id: "#812.1", name: "Флаг у субагентов", d: 2, st: "review", cost: "0.31" },
  { kind: "", id: "#808", name: "Флаг контекста в дереве", d: 1, st: "queued", cost: "—", tag: "next" },
  { kind: "", id: "#814", name: "Rollout codex без файла", d: 1, st: "blocked", cost: "0.12" },
];
</script>

<template>
  <div class="kit cu-graticule">
    <header class="cu-box hero">
      <div class="lock">
        <div class="cu-mark" style="--s: 64px"></div>
        <div class="lock-txt">
          <div class="cu-wordmark" style="--fs: 72px">CU<em>.</em></div>
          <span class="cu-t-cap">Coding Usage · Claude Usage</span>
        </div>
      </div>
      <p class="cu-t-body">Витрина UI-kit: токены, шрифты и компоненты в пяти вариантах темы. Выбор здесь — только предпросмотр, в настройках он не сохраняется.</p>
      <div class="row">
        <CuSeg v-model="theme" :options="themeOptions" />
        <span class="cu-tag">data-theme = {{ theme }}</span>
      </div>
      <div class="wll">
        <span class="cu-t-cap">WLL · рабочая нагрузка плана</span>
        <div class="cu-scale">
          <div class="trk"></div>
          <div class="fill" style="width: 80%; --c: var(--hemp)"></div>
          <div class="mark" style="left: 80%" data-l="$9.59"></div>
        </div>
      </div>
    </header>

    <section class="cu-box">
      <div class="cu-box-h"><span class="tt">Цвет</span><span class="sp cu-t-cap">оранжевый = нагрузка и критический путь</span></div>
      <div class="cu-box-b stack">
        <div>
          <div class="lbl">Поверхности и текст</div>
          <div class="sw-grid">
            <div v-for="v in surfaces" :key="v" class="swatch" :style="{ '--v': `var(${v})` }"><div class="c"></div><div class="n">{{ v }}</div></div>
          </div>
        </div>
        <div>
          <div class="lbl">Сигналы</div>
          <div class="sw-grid">
            <div v-for="v in signals" :key="v" class="swatch" :style="{ '--v': `var(${v})` }"><div class="c"></div><div class="n">{{ v }}</div></div>
          </div>
        </div>
        <div>
          <div class="lbl">Агенты</div>
          <div class="sw-grid">
            <div v-for="v in agents" :key="v" class="swatch" :style="{ '--v': `var(${v})` }"><div class="c"></div><div class="n">{{ v }}</div></div>
          </div>
          <div class="row" style="margin-top: 10px">
            <span class="cu-agent claude">claude-code</span>
            <span class="cu-agent codex">codex</span>
            <span class="cu-agent gemini">gemini-cli</span>
            <span class="cu-agent">custom</span>
          </div>
        </div>
      </div>
    </section>

    <div class="g2">
      <section class="cu-box">
        <div class="cu-box-h"><span class="tt">Шрифт</span></div>
        <div class="cu-box-b">
          <div class="type-row"><span class="t-11">32 · hero</span><span class="t-32">$9.59</span></div>
          <div class="type-row"><span class="t-11">22 · section</span><span class="t-22">Дерево работы сессий</span></div>
          <div class="type-row"><span class="t-11">16 · heading</span><span class="t-16">Готово, когда · 4 / 5</span></div>
          <div class="type-row"><span class="t-11">13 · body</span><span class="t-13">Агент разбивает изменение на задачи и проходит их волнами по зависимостям.</span></div>
          <div class="type-row"><span class="t-11">12 · caption</span><span class="t-12">Обновлено 2 минуты назад</span></div>
          <div class="type-row"><span class="t-11">11 · label</span><span class="t-11">W3 · 48 min · 312k tok</span></div>
        </div>
      </section>

      <section class="cu-box">
        <div class="cu-box-h"><span class="tt">Управление</span></div>
        <div class="cu-box-b stack">
          <div>
            <div class="lbl">Кнопки</div>
            <div class="row">
              <button class="cu-btn primary">Продолжить <span class="kbd">F5</span></button>
              <button class="cu-btn route">Крит. путь</button>
              <button class="cu-btn">Пауза</button>
              <button class="cu-btn ghost">Отмена</button>
              <button class="cu-btn danger">Стоп агента</button>
              <button class="cu-btn sm">Мелкая</button>
              <button class="cu-btn" disabled>Нельзя</button>
            </div>
          </div>
          <div>
            <div class="lbl">Сегменты · чипы</div>
            <div class="row">
              <CuSeg v-model="view" :options="viewOptions" />
              <button class="cu-chip on">в работе 3</button>
              <button class="cu-chip">ревью 1</button>
              <button class="cu-chip">блок 1</button>
            </div>
          </div>
          <div>
            <div class="lbl">Поля</div>
            <div class="row">
              <label class="cu-field" style="width: 240px"><span class="pfx">⌕</span><input placeholder="#, p#, текст" /></label>
              <label class="cu-field" style="width: 120px"><span class="pfx">WLL $</span><input value="12.00" /></label>
            </div>
          </div>
          <div>
            <div class="lbl">Флажки</div>
            <div class="row" style="gap: 20px">
              <CuToggle v-model="route">Критический путь</CuToggle>
              <CuToggle v-model="hideDone">Скрыть готовые</CuToggle>
              <CuToggle v-model="costs">$ на узлах</CuToggle>
            </div>
          </div>
        </div>
      </section>
    </div>

    <section class="cu-box">
      <div class="cu-box-h"><span class="tt">Статусы · метки · нагрузка</span></div>
      <div class="cu-box-b stack">
        <div class="row" style="gap: 18px">
          <span v-for="s in statuses" :key="s.cls" class="cu-st" :class="s.cls"><i></i><span>{{ s.label }}</span></span>
        </div>
        <div class="row">
          <span class="cu-id">{{ formatRef(66) }}</span>
          <span class="cu-id">#808</span>
          <span class="cu-cost">1.94</span>
          <span class="cu-tag route">путь</span>
          <span class="cu-tag next">далее</span>
          <span class="cu-tag">W4</span>
        </div>
        <div>
          <div class="lbl">Предел нагрузки · превышение</div>
          <div class="cu-scale" style="max-width: 520px">
            <div class="trk"></div>
            <div class="fill" style="width: 84%; --c: var(--hemp)"></div>
            <div class="over" style="width: 16%"></div>
            <div class="mark" style="left: 84%" data-l="лимит"></div>
          </div>
          <div class="cu-scale-ticks" style="max-width: 520px"><span>$0</span><span>$14.30 / $12.00 · +19%</span><span>$17</span></div>
        </div>
        <div class="cu-legend">
          <span class="sw" style="--c: var(--hemp)"></span><span>критический путь</span>
          <span class="sw" style="--c: var(--line-3)"></span><span>зависимость</span>
          <span class="sw dash" style="--c: var(--line-3)"></span><span>от готовой задачи</span>
        </div>
        <div class="cu-hazard" style="width: 120px"></div>
      </div>
    </section>

    <section class="cu-box">
      <div class="cu-box-h"><span class="tt">Дерево</span><span class="sp"><button class="cu-btn sm ghost">⋯</button></span></div>
      <div class="cu-tree">
        <div v-for="r in tree" :key="r.id" class="cu-tr" :class="r.kind">
          <span class="nm">
            <span v-if="r.d === 0" class="car">▾</span>
            <span v-else class="guide" :style="{ '--d': r.d }"></span>
            <span class="cu-id">{{ r.id }}</span>
            <b>{{ r.name }}</b>
          </span>
          <span v-if="r.agent" class="cu-agent" :class="r.agent">{{ r.agent }}</span>
          <span v-else-if="r.tag" class="cu-tag" :class="r.tag">{{ r.tag === "route" ? "путь" : "далее" }}</span>
          <span v-else></span>
          <span class="cu-st" :class="r.st"><i></i></span>
          <span class="cu-cost">{{ r.cost }}</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.kit {
  height: 100%;
  overflow: auto;
  box-sizing: border-box;
  padding: 28px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  color: var(--paper);
  font-family: var(--sans);
  font-size: var(--fs-13);
}
.hero {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.lock {
  display: flex;
  align-items: center;
  gap: 16px;
}
.lock-txt {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hero p {
  margin: 0;
  max-width: 620px;
}
.wll {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-width: 520px;
}
.g2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 480px), 1fr));
  gap: 24px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.lbl {
  font-family: var(--mono);
  font-size: var(--fs-11);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--paper-3);
  margin-bottom: 8px;
}
.sw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  border-radius: var(--r-2);
  overflow: hidden;
  box-shadow: 0 0 0 1px var(--line);
}
.swatch {
  background: var(--ink-1);
  border-right: 1px solid var(--line);
}
.swatch .c {
  height: 48px;
  background: var(--v);
  border-bottom: 1px solid var(--line);
}
.swatch .n {
  padding: 7px 9px;
  font-family: var(--mono);
  font-size: var(--fs-11);
  font-weight: 600;
}
.type-row {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: 16px;
  align-items: baseline;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.type-row:last-child {
  border-bottom: 0;
}
</style>
