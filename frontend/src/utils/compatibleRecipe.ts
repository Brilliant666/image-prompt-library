import type { Translator } from './i18n';
import type { ApiProtocol, GenerationJobRecord } from '../types';
export const IMAGE25_MODELS = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-sunburst-2026-09-08'];
// Third-party model aliases: forward verbatim without asserting official capabilities.
export const COMPATIBLE_ENTERPRISE_MODELS = ['gpt-image-2.5-flare-enterprise', 'gpt-image-2.5-sunburst-enterprise'];
export const IMAGE25_QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
export const COMPATIBLE_SIZE_OPTIONS = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048', '2048x1152', '1152x2048', '3840x2160', '2160x3840'];
export const IMAGE_SIZES = COMPATIBLE_SIZE_OPTIONS;
export const LEGACY_RATIO_SIZES: Record<string, string> = { auto: 'auto', '1:1': '1024x1024', '3:4': '864x1152', '9:16': '720x1280', '4:3': '1152x864', '16:9': '1280x720' };
export interface CompatibleTransportOverrides {
  base_url_mode?: 'versioned' | 'custom';
  stream?: boolean;
  partial_images?: number;
  response_format?: 'auto' | 'b64_json' | 'url';
}
export interface CompatibleRecipe extends CompatibleTransportOverrides { service_preset?: 'generic'|'muse'; requested_aspect_ratio?: string; protocol?: ApiProtocol; provider_options?: Record<string,string|number|boolean>; model: string; quality: string; size: string; background: string; output_format: string; output_compression?: number; moderation?: 'auto'|'low'; size_mode?: 'auto4k'; legacyDerived?: boolean; transportLegacyDerived?: true }
const TRANSPORT_KEYS = ['base_url_mode', 'stream', 'partial_images', 'response_format'] as const;
// Same defaults used by run_job for historical requests predating these options.
// New composers intentionally omit these keys, allowing the selected API defaults.
const LEGACY_TRANSPORT: Required<CompatibleTransportOverrides> = { base_url_mode: 'versioned', stream: false, partial_images: 0, response_format: 'auto' };
/** Only safe request options may travel with a recipe or the current draft. */
export function pickCompatibleTransportOverrides(value: unknown): CompatibleTransportOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  return {
    ...(source.base_url_mode === 'versioned' || source.base_url_mode === 'custom' ? { base_url_mode: source.base_url_mode } : {}),
    ...(typeof source.stream === 'boolean' ? { stream: source.stream } : {}),
    ...(typeof source.partial_images === 'number' && Number.isInteger(source.partial_images) && source.partial_images >= 0 && source.partial_images <= 3 ? { partial_images: source.partial_images } : {}),
    ...(source.response_format === 'auto' || source.response_format === 'b64_json' || source.protocol === 'seedream_native' && source.response_format === 'url' ? { response_format: source.response_format } : {}),
  };
}
/** An explicit connection switch returns to its current API defaults. */
export function clearCompatibleTransportOverrides<T extends CompatibleRecipe>(recipe: T): T {
  const result = { ...recipe };
  for (const key of TRANSPORT_KEYS) delete result[key];
  delete result.transportLegacyDerived;
  return result;
}
// Compatible gateways may expose model aliases; names do not establish capabilities.
// Keep all supported request values available and let the service validate them.
export function imageQualities(_model: string) { return IMAGE25_QUALITIES; }
export function restoreCompatibleRecipe(job: Pick<GenerationJobRecord, 'parameters' | 'metadata' | 'model'>): CompatibleRecipe {
  const requested = job.metadata?.requested;
  const values = { ...job.parameters, ...(requested && typeof requested === 'object' ? requested as Record<string, unknown> : {}) };
  const recordedTransport = { ...pickCompatibleTransportOverrides(job.parameters), ...pickCompatibleTransportOverrides(requested) };
  const transport = { ...LEGACY_TRANSPORT, ...recordedTransport };
  const transportLegacyDerived = TRANSPORT_KEYS.some(key => recordedTransport[key] === undefined);
  const text = (key: string, fallback: string) => typeof values[key] === 'string' ? values[key] as string : fallback;
  if (values.service_preset === 'muse') return {...recordedTransport,...museRecipeDefaults(text('model',job.model||'')),requested_aspect_ratio:museAspectRatio(values)};
  if (values.protocol === 'gemini_native' || values.protocol === 'seedream_native') {
    const options = values.provider_options && typeof values.provider_options === 'object' && !Array.isArray(values.provider_options)
      ? Object.fromEntries(Object.entries(values.provider_options).filter((entry): entry is [string,string|number|boolean] => ['string','number','boolean'].includes(typeof entry[1]))) : {};
    return {...recordedTransport, protocol:values.protocol, model:text('model',job.model||''), quality:text('quality','auto'), size:text('size','auto'),
      background:text('background','auto'), output_format:text('output_format','auto'), provider_options:options,
      ...(typeof values.output_compression==='number'?{output_compression:values.output_compression}:{}),
      ...(values.moderation==='auto'||values.moderation==='low'?{moderation:values.moderation}:{})};
  }
  return { ...transport, ...(transportLegacyDerived ? { transportLegacyDerived: true as const } : {}), ...(values.size_mode === 'auto4k' ? { size_mode: 'auto4k' as const } : {}), model: text('model', job.model || ''), quality: text('quality', 'low'), size: text('size', LEGACY_RATIO_SIZES[String(values.requested_aspect_ratio || 'auto')] || 'auto'), background: text('background', 'auto'), output_format: text('output_format', 'png'), ...(typeof values.output_compression === 'number' ? { output_compression: values.output_compression } : {}), ...(values.moderation === 'auto' || values.moderation === 'low' ? {moderation:values.moderation} : {}), legacyDerived: !values.size };
}
export function compatibleValidation(recipe: CompatibleRecipe): Parameters<Translator>[0] | undefined {
  if (!recipe.model.trim()) return 'imageModelRequired';
  if (recipe.service_preset==='muse') return recipe.model==='muse-image' && MUSE_ASPECT_RATIOS.includes(museAspectRatio(recipe)) ? undefined : 'imageQualityUnsupported';
  if (recipe.protocol && recipe.protocol !== 'openai_compatible') return nativeParameterIssue(recipe) ? 'imageQualityUnsupported' : undefined;
  if (!imageQualities(recipe.model).includes(recipe.quality)) return 'imageQualityUnsupported';
  if (!['auto', 'opaque', 'transparent'].includes(recipe.background)) return 'imageBackgroundInvalid';
  if (!['png', 'jpeg', 'webp'].includes(recipe.output_format)) return 'imageFormatInvalid';
  if (recipe.background === 'transparent' && recipe.output_format === 'jpeg') return 'imageTransparencyConflict';
  if (recipe.output_format !== 'png' && recipe.output_compression !== undefined && (!Number.isInteger(recipe.output_compression) || recipe.output_compression < 0 || recipe.output_compression > 100)) return 'imageCompressionInvalid';
  if (recipe.size !== 'auto') {
    const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(recipe.size);
    if (!match) return 'imageSizeInvalid';
    const w = Number(match[1]), h = Number(match[2]);
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) return 'imageSizeInvalid';
    if (IMAGE25_MODELS.includes(recipe.model) && (w > 3840 || h > 3840 || w % 16 || h % 16 || Math.max(w, h) / Math.min(w, h) > 3 || w * h < 655360 || w * h > 8294400)) return 'imageSizeInvalid';
  }
}
export function compatibleParameters(recipe: CompatibleRecipe) {
  if (recipe.service_preset==='muse') {
    const error=compatibleValidation(recipe);if(error)throw new Error(error);
    return {model:recipe.model,service_preset:'muse' as const,size:'auto',quality:'auto',background:'auto',output_format:'auto',requested_aspect_ratio:museAspectRatio(recipe),...pickCompatibleTransportOverrides(recipe),n:1};
  }
  if (recipe.protocol && recipe.protocol !== 'openai_compatible') {
    const error = nativeParameterIssue(recipe);
    if (error) throw new Error(error);
    return {protocol:recipe.protocol,model:recipe.model,size:recipe.size,quality:recipe.quality,
      background:recipe.background,output_format:recipe.output_format,provider_options:{...(recipe.provider_options||{})},
      ...pickCompatibleTransportOverrides(recipe),n:1};
  }
  const error = compatibleValidation(recipe);
  if (error) throw new Error(error);
  if (recipe.moderation !== undefined && !['auto','low'].includes(recipe.moderation)) throw new Error('审核强度须为 auto 或 low');
  const transport = pickCompatibleTransportOverrides(recipe);
  if (TRANSPORT_KEYS.some(key => recipe[key] !== undefined && transport[key] === undefined)) throw new Error('历史请求的传输配置无效，请重新选择 API 配置');
  return { model: recipe.model, quality: recipe.quality, size: recipe.size, background: recipe.background, output_format: recipe.output_format, ...(recipe.output_format !== 'png' && recipe.output_compression !== undefined ? { output_compression: recipe.output_compression } : {}), ...(recipe.moderation !== undefined ? {moderation:recipe.moderation} : {}), ...transport, n: 1 };
}
/** Defaults apply only after an explicit connection/reset choice, never on a late catalog refresh. */
export function nativeRecipeDefaults(protocol: ApiProtocol, model=''): CompatibleRecipe {
  if (protocol === 'openai_compatible') return {model,quality:'auto',size:'auto',background:'auto',output_format:'png'};
  return {protocol,model,quality:'auto',size:'auto',background:'auto',output_format:'auto',provider_options:{}};
}

/** Exact documented models narrow choices; aliases stay editable and unverified. */
export function geminiModelOptions(model: string) {
  const all = ['auto','1:1','1:4','4:1','1:8','8:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'];
  const standard = all.filter(value => !['1:4','4:1','1:8','8:1'].includes(value));
  const exact = model.replace(/^models\//,'');
  if (['gemini-2.5-flash-image','gemini-2.5-flash-image-preview'].includes(exact)) return {ratios:standard,resolutions:['auto']};
  if (['gemini-3-pro-image','gemini-3-pro-image-preview'].includes(exact)) return {ratios:standard,resolutions:['auto','1K','2K','4K']};
  if (exact === 'gemini-nano-banana-2.1') return {ratios:all,resolutions:['auto','1K','2K','4K']};
  if (exact === 'gemini-3.1-flash-lite-image') return {ratios:standard,resolutions:['auto','1K']};
  return {ratios:all,resolutions:['auto','512','1K','2K','4K']};
}
export function seedreamModelOptions(model: string) {
  if (['doubao-seedream-5-0-pro-260628','doubao-seedream-5-0-flash-260915'].includes(model)) return {sizes:['auto','1K','1.5K','2K'],minPixels:921600,maxPixels:4624220};
  if (model === 'doubao-seedream-5-0-lite-260128') return {sizes:['auto','2K','3K','4K'],minPixels:3686400,maxPixels:16777216};
  if (model === 'doubao-seedream-4-5-251128') return {sizes:['auto','2K','4K'],minPixels:3686400,maxPixels:16777216};
  if (model === 'doubao-seedream-4-0-250828') return {sizes:['auto','1K','2K','4K'],minPixels:921600,maxPixels:16777216};
  return {sizes:['auto','1K','1.5K','2K','3K','4K'],minPixels:921600,maxPixels:16777216};
}

/** Presentation preflight; the backend remains authoritative and validates model-specific bounds. */
export function nativeParameterIssue(recipe: CompatibleRecipe): string | undefined {
  const protocol = recipe.protocol || 'openai_compatible';
  if (protocol === 'openai_compatible') return;
  if (!recipe.model.trim()) return '请选择完整模型 ID。';
  const options = recipe.provider_options || {};
  const allowed = protocol === 'gemini_native' ? ['aspect_ratio','resolution'] : ['watermark'];
  if (Object.keys(options).some(key=>!allowed.includes(key))) return '配方包含当前原生协议不支持的厂商选项，请明确调整。';
  if (recipe.quality !== 'auto' || !['auto',''].includes(recipe.background || '') || recipe.moderation && recipe.moderation !== 'auto'
      || recipe.output_compression !== undefined || recipe.stream === true || (recipe.partial_images || 0) !== 0 || recipe.size_mode)
    return '已有质量、背景、压缩或传输设置不适用于当前原生协议，请明确调整；提示词和图片不会修改。';
  if (protocol === 'gemini_native') {
    if (recipe.size !== 'auto' || recipe.output_format !== 'auto' || recipe.response_format && recipe.response_format !== 'auto')
      return 'Gemini 使用画面比例和分辨率，尺寸与格式需设为自动。';
    const capability = geminiModelOptions(recipe.model);
    if (options.aspect_ratio !== undefined && !capability.ratios.includes(String(options.aspect_ratio))) return '不支持此 Gemini 画面比例。';
    if (options.resolution !== undefined && !capability.resolutions.includes(String(options.resolution))) return '不支持此 Gemini 分辨率。';
    if (['gemini-2.5-flash-image','gemini-2.5-flash-image-preview'].includes(recipe.model.replace(/^models\//,'')) && options.resolution && options.resolution !== 'auto') return '此模型不支持明确的 imageSize，请使用模型默认。';
  } else {
    if (options.watermark !== undefined && typeof options.watermark !== 'boolean') return '水印选项必须为开或关。';
    if (!['auto','png','jpeg'].includes(recipe.output_format)) return 'Seedream 的输出格式需为自动、PNG 或 JPEG。';
    if (['doubao-seedream-4-5-251128','doubao-seedream-4-0-250828'].includes(recipe.model) && !['auto','jpeg'].includes(recipe.output_format)) return '此 Seedream 模型仅输出 JPEG，请调整格式。';
    const capability = seedreamModelOptions(recipe.model);
    const dimensions = /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/.exec(recipe.size);
    if (dimensions) {
      const width=Number(dimensions[1]),height=Number(dimensions[2]);
      if (width*height < capability.minPixels || width*height > capability.maxPixels || Math.max(width,height)>16*Math.min(width,height)) return 'Seedream 尺寸超出所选模型范围。';
    } else if (!capability.sizes.includes(recipe.size)) return 'Seedream 尺寸不适用于所选模型。';
  }
}

// 1% relative ratio error tolerates integer pixel rounding; shared with the backend.
export const ASPECT_RATIO_RELATIVE_TOLERANCE = 0.01;
export function explicitAspectRatio(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]*:[1-9][0-9]*$/.test(value)) return;
  const [w, h] = value.split(':').map(Number);
  if (Number.isSafeInteger(w) && Number.isSafeInteger(h)) return w / h;
}
function ratioDiffers(width: number, height: number, target: number) {
  return Math.abs(width / height / target - 1) > ASPECT_RATIO_RELATIVE_TOLERANCE;
}
export function imageSizeInfo(size: string, ratio: string) {
  const [w, h] = size.split('x').map(Number), target = explicitAspectRatio(ratio);
  return { experimental: w * h > 3686400, conflict: Boolean(w > 0 && h > 0 && target && ratioDiffers(w, h, target)) };
}
export function compatibleMismatches(job: GenerationJobRecord): Parameters<Translator>[0][] {
  const requested = job.metadata?.requested as Record<string, unknown> | undefined;
  const decoded = job.metadata?.decoded_image as Record<string, unknown> | undefined;
  if (!requested) return [];
  const issues: Parameters<Translator>[0][] = [];
  const explicitSize = typeof requested.size === 'string' && /^[1-9][0-9]*x[1-9][0-9]*$/.test(requested.size);
  const target = explicitAspectRatio(requested.requested_aspect_ratio);
  const width = decoded?.width, height = decoded?.height;
  const decodedDimensions = typeof width === 'number' && Number.isSafeInteger(width) && width > 0 && typeof height === 'number' && Number.isSafeInteger(height) && height > 0;
  // Explicit pixels win. A contradictory composition hint is a local settings conflict,
  // not an additional upstream ratio failure.
  if (explicitSize && imageSizeInfo(String(requested.size), String(requested.requested_aspect_ratio)).conflict) issues.push('imageRatioConflict');
  if (decodedDimensions) {
    if (explicitSize && requested.size !== `${width}x${height}`) issues.push('imageSizeMismatch');
    else if (!explicitSize && target && ratioDiffers(width, height, target)) issues.push('imageAspectRatioMismatch');
  }
  if (requested.output_format && requested.output_format !== 'auto' && decoded?.format && String(requested.output_format).toLowerCase().replace('jpg', 'jpeg') !== String(decoded?.format).toLowerCase().replace('jpg', 'jpeg')) issues.push('imageFormatMismatch');
  if (requested.background === 'transparent' && decoded?.has_transparent_pixels === false) issues.push('imageAlphaMismatch');
  const response = job.metadata?.response as Record<string, unknown> | undefined;
  if (requested.quality && requested.quality !== 'auto' && response?.quality && requested.quality !== response.quality) issues.push('imageQualityMismatch');
  return issues;
}

/** Display the exact request dimensions; never derive or replace a stored size. */
export function imageSizeLabel(size: string): string {
  const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(size);
  if (!match) return size;
  const width = Number(match[1]), height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return size;
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${size} (${width / divisor}:${height / divisor})`;
}
/** Compact preset names only; not a provider billing tier or a quality setting. */
export function imageSizeBadge(size: string): string {
  if (size === 'auto') return 'auto';
  const presets: Record<string, string> = {
    '1024x1024': '1K',
    '1536x1024': '1K', '1024x1536': '1K',
    '2048x2048': '2K', '2048x1152': '2K', '1152x2048': '2K',
    '3840x2160': '4K', '2160x3840': '4K',
  };
  // Custom dimensions remain exact in the tooltip; do not guess a K tier.
  return presets[size] || 'px';
}
export function imageQualityLabel(value: string, t: Translator): string {
  const keys: Record<string, Parameters<Translator>[0]> = { auto: 'generationAuto', low: 'generationLow', medium: 'generationMedium', high: 'generationHigh', xhigh: 'generationXhigh', max: 'generationMax' };
  if (!keys[value]) return value;
  const label = t(keys[value]);
  return label.toLowerCase() === value ? label : `${label} (${value})`;
}

/** Local size policy only. The provider always receives concrete pixels, never auto4k. */
export function resolveAuto4k(prompt: string, reference?: { width: number; height: number }) {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const ratios = new Map<string, [number, number]>();
  const normalized = prompt.normalize('NFKC');
  for (const match of normalized.matchAll(/(?<![\w:])(\d{1,5})\s*[:：]\s*(\d{1,5})(?![\w:])/g)) {
    const before = normalized.slice(Math.max(0, match.index! - 30), match.index);
    const explicitLabel = /(?:宽高比|比例|aspect\s*ratio|ratio)\s*[:=]?\s*$/i.test(before);
    if (!explicitLabel && !['9:16', '16:9', '4:3', '3:4', '2:3', '3:2', '1:1', '16:10', '10:16', '21:9', '9:21'].includes(`${Number(match[1])}:${Number(match[2])}`) && match[2].length === 2 && Number(match[1]) <= 23 && Number(match[2]) <= 59) continue;
    const w = Number(match[1]), h = Number(match[2]);
    if (!w || !h) continue;
    const d = gcd(w, h);
    ratios.set(`${w / d}:${h / d}`, [w / d, h / d]);
  }
  if (ratios.size > 1) return { error: 'imageAuto4kConflict' as const };
  const pair = [...ratios.values()][0];
  const source = pair ? 'prompt' : reference ? 'reference' : 'default';
  const [w, h] = pair || (reference ? [reference.width, reference.height] : [1, 1]);
  const target = w / h;
  if (!Number.isFinite(target) || target < 1 / 3 || target > 3) return { error: 'imageSizeInvalid' as const };
  const d = gcd(w, h), a = w / d, b = h / d;
  const k = Math.floor(Math.min(3840 / (a * 16), 3840 / (b * 16), Math.sqrt(8294400 / (a * b)) / 16));
  let width = a * k * 16, height = b * k * 16;
  // Prefer exact ratios near the target; awkward ratios must not collapse to a small image.
  const targetArea = Math.min(8294400, 3840 * 3840 / Math.max(target, 1 / target));
  if (width * height < targetArea * 0.95) {
    for (let x = 16; x <= 3840; x += 16) {
      const y = Math.round(x / target / 16) * 16;
      if (y < 16 || y > 3840 || x * y > 8294400 || x * y < 655360 || Math.max(x, y) / Math.min(x, y) > 3) continue;
      if (Math.abs(x / y / target - 1) <= 0.003 && x * y > width * height) { width = x; height = y; }
    }
  }
  if (!width || !height) return { error: 'imageSizeInvalid' as const };
  return { size: `${width}x${height}`, source, ratio: `${w / d}:${h / d}` };
}

/** Muse's documented composition ratios are hints, never pixel-size guarantees. */
export const MUSE_ASPECT_RATIOS = ['auto','1:1','16:9','9:16','4:3','3:4'];
export function museAspectRatio(value: {requested_aspect_ratio?: unknown; size?: unknown}): string {
  if (typeof value.requested_aspect_ratio === 'string' && value.requested_aspect_ratio !== 'auto') return value.requested_aspect_ratio;
  const pixels = typeof value.size === 'string' ? /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(value.size) : null;
  if (pixels) {
    const width = Number(pixels[1]), height = Number(pixels[2]), ratio = width / height;
    const documented = MUSE_ASPECT_RATIOS.slice(1).find(text => {
      const [w,h] = text.split(':').map(Number);
      return Math.abs(ratio / (w/h) - 1) <= .01;
    });
    if (documented) return documented;
    const gcd = (a:number,b:number):number => b ? gcd(b,a%b) : a;
    const divisor = gcd(width,height);
    return `${width/divisor}:${height/divisor}`;
  }
  return 'auto';
}
export function museRecipeDefaults(model='muse-image'): CompatibleRecipe {
  return {service_preset:'muse',model,size:'auto',requested_aspect_ratio:'auto',quality:'auto',background:'auto',output_format:'auto'};
}
