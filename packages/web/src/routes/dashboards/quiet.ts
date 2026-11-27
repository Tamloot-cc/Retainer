// The renderer checks this flag before mounting its development inspector.
(globalThis as Record<symbol, unknown>)[Symbol.for('openui.devtools.autoMount')] = true;
