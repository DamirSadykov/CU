# Инвентарь настроек перед 1.0

Снимок на 2026-10-14. Источник состава и scope —
[`scripts/cli/kernel/settings-contract.json`](../scripts/cli/kernel/settings-contract.json),
место и подпись — текущий `SettingsPanel.vue`, читатели — поиск по `src`,
`src-tauri`, `resolver` и `scripts/cli`. Таблица фиксирует исходные 49 ключей;
добавленный соседним изменением `parkedStepExpiryHours` в этот снимок не входил.

Вердикты ниже **приняты пользователем 2026-10-14** и исполнены в t#1250.
2026-10-15 подключение Claude и Codex вынесено на вкладку «Провайдеры», интервал
опроса — на «Обновления»; столбец «Вкладка» отражает новое место.
Тогда же добавлен ключ `runnerEnabled` (см. «Режим работы» ниже).

- **keep** — оставить отдельным ключом;
- **drop** — удалить настройку и возможность её задавать;
- **merge** — сохранить возможность, но объединить с указанным ключом в одну
  структурную настройку;
- **move** — значение нужно, но это cache/runtime state, а не пользовательская
  настройка, поэтому его следует хранить отдельно.

`UI → Rust AppConfig` означает: панель/`App.vue` читает ключ через
`settingsStore.ts` и передаёт его в backend-команду `configure`; служебный слой
`settingsStore.ts` в каждой такой строке повторно не перечислен. «Нет поля»
означает именно отсутствие редактируемого контрола в `SettingsPanel`, а не
отсутствие читателя.

| Ключ | Scope | Вкладка → подпись в SettingsPanel | Кто читает | Умолчание | Предложенный вердикт и причина |
|---|---|---|---|---|---|
| `sessionKey` | ui | Провайдеры → «Session Key» | `App.vue` → Rust usage API | `""` | **keep** — обязательная учётная пара для Claude usage API. |
| `orgId` | ui | Провайдеры → «Organization ID» | `App.vue` → Rust usage API | `""` | **keep** — второй обязательный идентификатор Claude usage API. |
| `refreshInterval` | ui | Обновления → «Интервал обновления» | `App.vue` → Rust polling/AppConfig | `60` с | **keep** — понятный пользователю компромисс свежести и частоты запросов. |
| `autoStartSession` | ui | Аккаунт → «Автостарт сессии» | `App.vue` → Rust AppConfig; `SessionCard.vue` | `false` | **keep** — самостоятельная автоматизация с заметным внешним эффектом. |
| `projectId` | ui | — нет поля; создаётся автоматически | `App.vue` → Rust start-session API | `""` | **move** — это внутренний UUID созданного проекта, а не предпочтение пользователя. |
| `thresholdsSession` | ui | Пороги → «Пороги сессии (5ч)» | `App.vue` → Rust alerts; tray colour | `[25, 50, 75]` | **keep** — отдельная шкала для 5-часового лимита. |
| `thresholdsWeekly` | ui | Пороги → «Пороги недели (7д / Opus / Sonnet / доп.)» | `App.vue` → Rust alerts | `[25, 50, 75]` | **keep** — недельная шкала имеет иной горизонт и меняется независимо. |
| `notificationsEnabled` | ui | Уведомления → «Уведомления» | `App.vue` → Rust alert engine | `false` | **keep** — явный master opt-in системных usage-уведомлений. |
| `notifyForecastMinutes` | ui | Уведомления → «Прогноз исчерпания» | `App.vue` → Rust forecast alert | `30` мин | **keep** — порог срабатывания, не совпадает с окном расчёта прогноза. |
| `forecastWindowMinutes` | ui | Пороги → «Окно усреднения темпа» | `App.vue` → Rust forecast/statistics; usage-card ETA | `60` мин | **keep** — управляет устойчивостью расчёта, а не только уведомлением. |
| `alertTiers` | ui | Уведомления → «Уведомлять о» | `App.vue` → Rust alert engine | все 5 tiers = `true` | **keep** — компактная карта независимых видов лимита уже объединена правильно. |
| `alertTypes` | ui | Уведомления → «Типы оповещений» | `App.vue` → Rust alert engine | `threshold/reset/forecast = true` | **keep** — ортогональная к tiers карта типов событий. |
| `quietHoursEnabled` | ui | Уведомления → «Тихие часы» | `App.vue` → Rust alert engine | `false` | **merge** → `quietHours`; флаг и границы образуют одну настройку. |
| `quietHoursStart` | ui | Уведомления → «С» | `App.vue` → Rust alert engine | `"23:00"` | **merge** → `quietHours`; отдельно от enabled/end смысла не имеет. |
| `quietHoursEnd` | ui | Уведомления → «До» | `App.vue` → Rust alert engine | `"08:00"` | **merge** → `quietHours`; отдельно от enabled/start смысла не имеет. |
| `ccAnalyticsEnabled` | ui | Бюджет → «Аналитика Claude Code и Codex» | `App.vue`; Rust local analytics/domain | `false` | **keep** — privacy-sensitive master opt-in локального чтения транскриптов. |
| `dailyBudgetEnabled` | ui | Бюджет → «Дневной бюджет» | `App.vue`; Rust budget alert/domain; `ProjectOverview.vue` | `false` | **merge** → `dailyBudget` nullable; отдельный флаг создаёт состояние «включено, 0». |
| `dailyBudget` | ui | Бюджет → «Бюджет в день ($/% от недельного)» | `App.vue`; Rust budget alert/domain; `UsagePanel.vue` | `0` | **merge** → nullable `dailyBudget`; единица по-прежнему следует `ccAnalyticsEnabled`. |
| `goalCostPerHourMax` | ui | Бюджет → «$/активный час, макс» | `AnalyticsWindow.vue` | `null` | **keep** — независимая необязательная цель; `null` уже выражает выключенное состояние. |
| `goalErrorRateMax` | ui | Бюджет → «Доля ошибок инструментов, макс (%)» | `AnalyticsWindow.vue` | `null` | **keep** — независимая необязательная цель; хранится долей 0..1. |
| `notificationsMutedUntil` | ui | — нет поля; действие временного mute в главном окне | `App.vue`; notification presenter | `null` | **move** — это истекающее runtime-состояние, не постоянное предпочтение Settings. |
| `serviceStatusEnabled` | ui | Уведомления → «Статус сервиса Claude» | `App.vue` → Rust service-status worker | `true` | **keep** — master switch отдельного сетевого источника. |
| `serviceStatusInterval` | ui | Уведомления → «Интервал проверки статуса» | `App.vue` → Rust service-status worker | `90` с | **keep** — явный пользовательский trade-off частоты опроса. |
| `serviceStatusNotify` | ui | Уведомления → «Уведомлять об изменении статуса» | `App.vue` → Rust service-status worker | `true` | **keep** — показ статуса и системные уведомления полезно включать независимо. |
| `memoryBloatEnabled` | ui | Уведомления → «Сигнал о раздувании памяти» | `App.vue` memory-bloat watcher | `true` | **keep** — самостоятельный локальный диагностический сигнал. |
| `todoNotificationsEnabled` | ui | Уведомления → «Уведомления о задачах» | `App.vue` / todo file watcher | `true` | **keep** — отдельный канал событий, не связанный с usage alerts. |
| `runtimeInsightsEnabled` | ui | Выводы → «Советы по оптимизации (бета)» | `App.vue` → Rust runtime insight engine | `false` | **merge** → `runtimeInsights`; master и набор kinds составляют одну capability. |
| `runtimeInsightKinds` | ui | Выводы → колонка «Runtime» у каждой метрики | `App.vue` → Rust runtime insight engine | `["long_session", "cold_rewrites"]` | **merge** → `runtimeInsights`; хранить `{enabled, kinds}` вместе. |
| `keepAwakeEnabled` | ui | Аккаунт → «Не давать Windows засыпать во время работы ИИ» | `App.vue` → Rust keep-awake worker | `false` | **keep** — явное управление поведением ОС с понятным opt-in. |
| `systemInfoEnabled` | ui | Аккаунт → «Системная информация в мини-панели» | `MiniPanel.vue` | `true` | **keep** — пользователь решает, показывать ли системные CPU/RAM. |
| `correctionsEnabled` | ui | Бюджет → «Метрика исхода — поправки пользователя» | `App.vue` → Rust analytics; `AnalyticsWindow.vue` | `false` | **keep** — отдельный privacy-sensitive opt-in сканирования транскриптов. |
| `locale` | shared | Аккаунт → «Язык» | UI i18n; CLI `uiLocale()` | `null` (системный/текущий язык) | **keep** — единый язык UI и сообщений CLI. |
| `uiTheme` | ui | Аккаунт → «Внешний вид / Основа» | theme bootstrap и Settings UI | `"system"` | **keep** — базовая светлая/тёмная политика независима от skin. |
| `uiSkin` | ui | Аккаунт → «Внешний вид / Скин» | theme bootstrap и Settings UI | `"standard"` | **keep** — визуальный вариант поверх базовой темы. |
| `ignoredInsights` | ui | Выводы → колонка «Дашборд» у каждой метрики | `SettingsPanel.vue`; `AnalyticsWindow.vue` | `[]` | **keep** — это dashboard-видимость, не то же самое, что runtime-уведомления. |
| `resolverUrl` | ui | Интеграции → «Адрес resolver'а» | `EnrollmentPanel.vue` | `""` | **keep** — пользовательская endpoint-конфигурация self-hosted интеграции. |
| `updateCheckHours` | ui | Обновления → «Интервал проверки обновлений» | `kernel/updater.ts` | `6` ч | **keep** — понятная настройка фоновой сетевой активности. |
| `releasesCache` | ui | — нет поля | `kernel/changelog.ts` | `null` | **move** — производный cache ответа GitHub не относится к preferences. |
| `externalStatusMap` | ui | Интеграции → «Маппинг статусов» | `EnrollmentPanel.vue`; `TodoWindow.vue` | `{}` | **keep** — видимая пользовательская настройка соответствия статусов, сохраняемая и переопределяемая в `settings.json`. |
| `specsEnabled` | shared | Задачи → «Реестр спек для change'ей» | UI; CLI todos/session/start/stop/run-step | `false` | **keep** — явный master opt-in автоматического spec workflow. |
| `flowLanguages` | shared | Задачи → «Проверки / Языки кода по проектам» | UI; CLI `process/apply.mjs`, `lint.mjs` | `{}`; для проекта fallback `["cs"]` | **keep** — проектный выбор языков flow-check нужен CLI и уже естественно представлен map'ом. |
| `taskContextPriority` | shared | Задачи → «Приоритет задач в контексте» | UI; CLI SessionStart hook | `"medium"` | **keep** — регулирует объём автоматически вставляемого контекста. |
| `hookContextEnabled` | shared | Задачи → «Контекст задач в сессиях» | UI; CLI SessionStart hook | `true` | **keep** — master switch инъекции задач и prerequisite workflow context. |
| `workflowContextEnabled` | shared | Задачи → «Процесс ролей в начале сеанса» | UI; CLI SessionStart hook | `false` | **keep** — процесс ролей можно включать независимо от списка задач. |
| `taskHandoffGuard` | shared | Задачи → «Guard HANDOFF для задач» | UI; CLI Stop hook | `"both"` | **keep** — режим guard'а (`off/submitted/unfinished/both`) является самостоятельной политикой. |
| `specRoot` | shared | — нет поля; вручную в JSON | Rust spec reader; CLI spec registry | `"docs/specs"` | **keep** — переносимый project-relative root нужен обоим реализациям реестра. |
| `specDeltaGuard` | hook | — нет поля; вручную в JSON | CLI Stop hook | `"on"` | **merge** → `specs`/`specsEnabled`; это подрежим одной opt-in capability, отдельно он скрыт и инертен. |
| `matchPlanCli` | hook | — нет поля; вручную в JSON | CLI plan hook; todo event matcher | `""` | **keep** — необязательный adapter path сохраняет отсутствие жёсткой зависимости от KB. |
| `flowcheckExe` | — | — удалён | — | — | **removed** — путь вычисляется: `%APPDATA%/com.cu.app/tools/flowcheck.exe` или сборка `tools/flowcheck` репозитория CU; инструмент собирается из этого репозитория, своему пути взяться неоткуда. |
| `specRepos` | hook | — нет поля; вручную в JSON, map repo → path | CLI spec registry | `{}` | **keep** — локальные пути внешних repo машинно-зависимы и не подходят UI sync. |

## Дрейф контракта

- `flowcheckExe` обнаружен как прямое чтение из `settings.json` в
  `scripts/cli/process/run.mjs` и `scripts/cli/process/apply.mjs`. В t#1250 он
  добавлен в контракт как `scope: hook`, `writer: manual`; оба читателя теперь
  используют типизированный getter с default `""` (flowcheck не запускается).
- Legacy-ключ `thresholds` не является 50-м актуальным ключом: он читается только
  как migration fallback для `thresholdsSession`/`thresholdsWeekly`.
- `openAiAdminEnabled`, `openAiAdminKey`, `openAiUsageDays` при чтении удаляются;
  `uiFont` больше не читается. Это legacy, а не настройки текущего контракта.

## Итог

Из 49 контрактных ключей: **38 keep**, **0 drop**, **8 merge** и **3 move**.
Отдельно один фактический ключ (`flowcheckExe`) следует добавить в контракт.
Нулевой `drop` намеренный: наличие читателя доказывает использование, но не
актуальность; без пользовательского решения безопаснее сначала сократить
структурный шум и отделить state/cache, а удаление возможностей обсуждать
адресно на следующем шаге.

## Реализованный контракт

После миграции контракт содержал 43 ключа: 31 `ui`, 7 `shared` и 5 `hook`.
`quietHours`, nullable `dailyBudget`, `runtimeInsights` и `specs` заменяют восемь
плоских ключей; `flowcheckExe` теперь объявлен как ручной hook-ключ. UI и CLI
получают перечни ключей непосредственно из `settings-contract.json`, а Rust
берёт оттуда объявление и default `specRoot`.

При первом чтении прежние merge-ключи записываются в новую структуру и удаляются.
`projectId` и `notificationsMutedUntil` переносятся без перезаписи уже имеющегося
значения в `runtime-state.json`, `releasesCache` — в `cache.json`. Эти три ключа
остались в `legacy` только как разрешённые источники одноразовой миграции и больше
не входят в preferences-контракт.

## Режим работы

2026-10-15 вкладка «Задачи» получила «Режим работы» из четырёх ступеней, каждая
включает предыдущую:

- **Только учёт** — `hookContextEnabled: false`;
- **Задачи в сеансе** — `hookContextEnabled: true`, `workflowContextEnabled: false`;
- **План с проверкой** — плюс `workflowContextEnabled: true`, `runnerEnabled: false`,
  architect в режиме `agent`;
- **Раннер** — плюс `runnerEnabled: true` и review в режиме `agent`.

Режим не хранится: панель выводит его из этих значений, а выбор режима их
записывает. Не совпадающий ни с одним набор показывается как «Свой» и раскрывает
подробные настройки. Ради различия третьей и четвёртой ступени добавлен
shared-ключ `runnerEnabled` (default `true`): выключенный, он убирает раннер из
текста WORKFLOW, и план исполняет сам сеанс. Review вызывает только раннер,
поэтому «План с проверкой» его не трогает. Контракт теперь — 44 ключа: 31 `ui`,
8 `shared` и 5 `hook`.

## Проверки

2026-10-18 вкладка «Задачи» получила блок «Проверки»: поле пути к
`flowcheck.exe` с выбором файла и таблицу проектов с флажками `cs`, `rs`,
`ts`, `js`. Ключи `flowcheckExe` и `flowLanguages` переведены из ручных
hook-ключей в `shared` с писателем `app` и прямым чтением (`direct`).
Панель пишет `flowLanguages` слиянием: перечитывает map из файла и заменяет
только запись изменённого проекта, поэтому записи проектов, которых нет в
списке, сохраняются. Последний отмеченный язык снять нельзя: пустой список CLI
всё равно читает как `["cs"]`. Список проектов — ключи map и проекты из
`get_cc_projects`, тот же источник, что у поля проекта задачи. Контракт —
44 ключа: 31 `ui`, 10 `shared` и 3 `hook`.
