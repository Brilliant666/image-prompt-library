export type RecipeInput = {
  id: string; name: string; source: 'uploaded' | 'generated_result' | 'library';
  previewUrl: string; dataUrl?: string; resultPath?: string; imageId?: string;
  sourceItemId?: string; role?: string; missing?: boolean;
};

/** Keep missing inputs as ordered slots: a partial recipe must never become text-to-image. */
export function recipeInputs(job: { id?: string; mode?: string; parameters?: Record<string, unknown> }, mediaUrl: (path: string) => string): RecipeInput[] {
  const inputs = Array.isArray(job.parameters?.input_images) ? job.parameters.input_images : [];
  const restored = inputs.map((raw, index): RecipeInput => {
    const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const path = typeof input.result_path === 'string' ? input.result_path : undefined;
    const data = typeof input.data_url === 'string' ? input.data_url : undefined;
    return {
      id: typeof input.id === 'string' ? input.id : `job-${job.id}-${index}`,
      name: typeof input.name === 'string' ? input.name : `Reference ${index + 1}`,
      source: input.source === 'library' ? 'library' : input.source === 'generated_result' ? 'generated_result' : 'uploaded',
      resultPath: path, dataUrl: data,
      imageId: typeof input.image_id === 'string' ? input.image_id : undefined,
      sourceItemId: typeof input.source_item_id === 'string' ? input.source_item_id : undefined,
      role: typeof input.role === 'string' ? input.role : undefined,
      previewUrl: path ? mediaUrl(path) : data || '',
    };
  });
  return restored.length || !['image_edit', 'text_reference_to_image'].includes(job.mode || '') ? restored : [{ id: `missing-${job.id}`, name: 'Reference 1', source: 'uploaded', previewUrl: '', missing: true }];
}

export async function restoreRecipeInputs(inputs: RecipeInput[], read: (input: RecipeInput) => Promise<string>): Promise<RecipeInput[]> {
  return Promise.all(inputs.map(async input => {
    try {
      const dataUrl = await read(input);
      if (!dataUrl) throw new Error('Missing input');
      // Submit the verified original bytes, not a mutable library record or stale temporary path.
      return { ...input, source: 'uploaded' as const, dataUrl, previewUrl: dataUrl, resultPath: undefined, imageId: undefined, missing: false };
    } catch {
      return { ...input, dataUrl: undefined, missing: true };
    }
  }));
}

export function fillRecipeInputs(current: RecipeInput[], added: RecipeInput[], limit: number): RecipeInput[] {
  const remaining = [...added];
  const next = current.map(input => input.missing && remaining.length ? remaining.shift()! : input);
  return [...next, ...remaining].slice(0, limit);
}
