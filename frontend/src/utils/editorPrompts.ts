import type { PromptRecord } from '../types';

// Merge edits into existing records; language tags never establish which version is original.
export function mergeEditorPrompts(
  existing: PromptRecord[], fields: Record<string, string>, extraTexts: Record<string, string>, originalLanguage: string,
) {
  const seen = new Set<string>();
  const prompts = existing.map(prompt => {
    const editable = Object.hasOwn(fields, prompt.language) && !seen.has(prompt.language);
    seen.add(prompt.language);
    return { ...prompt, text: editable ? fields[prompt.language] : extraTexts[prompt.id] ?? prompt.text };
  });
  for (const [language, text] of Object.entries(fields)) {
    if (!seen.has(language) && text.trim()) prompts.push({ id: '', item_id: '', language, text, is_primary: false, is_original: false, provenance: { kind: 'manual' } });
  }
  const usable = prompts.filter(prompt => prompt.text.trim());
  const marked = usable.find(prompt => prompt.is_original);
  if (!marked || marked.language !== originalLanguage) {
    const source = usable.find(prompt => prompt.language === originalLanguage) || marked || usable[0];
    for (const prompt of usable) prompt.is_original = prompt === source;
  }
  if (!usable.some(prompt => prompt.is_primary) && usable[0]) usable[0].is_primary = true;
  return usable.map(({ language, text, is_original, is_primary, provenance }) => ({ language, text, is_original, is_primary, provenance }));
}
