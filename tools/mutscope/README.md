# mutscope

`mutscope` запускает mutation testing только для строк из git diff и поднимает
выжившие мутанты по автоматически найденной лестнице тестов. JavaScript и
TypeScript обслуживает StrykerJS, Rust — cargo-mutants. Результат — один JSON в
формате mutation-testing-elements с расширением `mutscope`.

## Запуск

Из корня репозитория:

```powershell
node tools/mutscope/cli.mjs
node tools/mutscope/cli.mjs --from 1 --to 2 --output artifacts/mutations.json
node tools/mutscope/cli.mjs main HEAD
node tools/mutscope/cli.mjs --staged
git diff main --unified=0 | node tools/mutscope/cli.mjs --diff-file -
```

По умолчанию команда читает `git diff HEAD`, проходит уровни 0–3, исключает
`StringLiteral` и пишет `mutscope-report.json`. `--keep-strings` возвращает
строковые мутанты. Записанный diff можно передать через `--diff-file <path>`;
полный список параметров печатает `--help`.

Для JS/TS нужны локальные `@stryker-mutator/core` и
`@stryker-mutator/vitest-runner`; для Rust команда `cargo mutants` должна быть
доступна в `PATH`.

## Лестница

Уровни содержат только новые тесты относительно предыдущих:

0. Соседний `x.test.*`/`x.spec.*`; для Rust — `tests/<module>.rs` и inline
   `mod tests` изменённого файла.
1. Тесты, чей граф относительных импортов доходит до файла; для Rust — тесты,
   ссылающиеся на модуль.
2. Тесты каталога слоя; для Rust — тесты и inline-тесты крейта.
3. Весь найденный набор.

Мутант начинает на `--from`. Убитый мутант останавливается, а `Survived` и
`NoCoverage` переходят выше до `--to`. Stryker получает точный диапазон
`file:L:C-L:C` (колонки MTE переводятся из one-based в zero-based),
cargo-mutants — точное экранированное имя через `--re`. Прогон не обрывается на
первом тесте: Stryker использует `disableBail`, cargo — `--no-fail-fast`.

## Отчёт и сводка

Каждый мутант получает `level` и `durationMsByLevel`. В `mutscope.levels`
лежат длительность, тесты и число мутантов каждого запуска. Для Stryker также
пишутся `mutscope.quarantined` и `mutscope.traces`; при нескольких изменённых
файлах записи помечены исходным файлом.

После записи JSON команда печатает:

- выбранные тесты — объединение `killedBy` всех мутантов;
- `Survived` — код исполнялся, но тесты не различили изменённое поведение;
- `NoCoverage` — изменённый код тестами не исполнялся.

Перед Stryker каждый тест проверяется под `threads` с одним worker. Падающий
там файл карантинится с причиной `threads`. Если файл падает только на dry run
Stryker, он карантинится с причиной `dryRun`, после чего уровень повторяется.

## Ограничения

- Статически разбираются только относительные JS/TS imports, exports,
  `require()` и `import()`; aliases и вычисляемые импорты в граф не входят.
- Покрытие дочерних Node-процессов собирается через `NODE_OPTIONS --import` и
  `__STRYKER_ACTIVE_MUTANT__`. Процесс, который заменил переданный `env`, или
  не-Node процесс покрытие не отдаст.
- cargo-mutants сообщает имена убивших тестов только в per-mutant логах; для
  выжившего мутанта конкретный список покрывших тестов неизвестен.
- Diff содержит только отслеживаемые Git файлы. Неотслеживаемый файл сначала
  нужно добавить в index либо передать самостоятельно подготовленный diff.

Unit-тесты логики не запускают мутаторы:

```powershell
npx vitest run tools/mutscope
```
