/**
 * Keeps OpenUI's devtools widget from mounting in development: it would add
 * an inspector panel and links to Thesys's console. Imported before
 * `@openuidev/react-lang`, which checks this flag when it loads. Production
 * builds drop the widget anyway.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true;
