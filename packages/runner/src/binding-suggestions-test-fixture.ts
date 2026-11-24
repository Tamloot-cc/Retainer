/**
 * A configure answer as the model sends it (`answerSchema`): each binding's
 * fields as a list of entries with their key, and a field's values as
 * value/option pairs. Tests write answers keyed by field, as the parser reads
 * them back; anything else, such as a lookup pick, passes through unchanged.
 */
export function wireAnswer(answer: unknown): unknown {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  return Object.fromEntries(
    Object.entries(answer).map(([key, choice]) => {
      const fields = (choice as { fields?: unknown } | null)?.fields;
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [key, choice];
      return [
        key,
        {
          ...choice,
          fields: Object.entries(fields as Record<string, { values?: Record<string, string> }>).map(
            ([field, { values, ...pick }]) => ({
              key: field,
              ...pick,
              ...(values && {
                values: Object.entries(values).map(([value, option]) => ({ value, option })),
              }),
            }),
          ),
        },
      ];
    }),
  );
}
