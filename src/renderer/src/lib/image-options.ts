/**
 * The ratio choices the image gateway accepts, written as the `size` values
 * the generator already uses. "Auto" leaves the gateway's own default in
 * place; the pixel pairs are the exact sizes the endpoint expects.
 */
export const IMAGE_RATIO_OPTIONS = [
  { value: '', label: 'Auto', shape: 'auto' },
  { value: '16:9', label: '16:9', shape: 'wide' },
  { value: '1536x1024', label: '3:2', shape: 'landscape' },
  { value: '1024x1536', label: '2:3', shape: 'portrait' },
  { value: '9:16', label: '9:16', shape: 'tall' },
  { value: '1024x1024', label: '1:1', shape: 'square' }
] as const

/** The gateway's image model ids, with the names the picker and cards show. */
export const IMAGE_MODEL_NAMES: Record<string, string> = {
  'codex/gpt-image-2': 'GPT Image 2',
  'grok/grok-imagine-image': 'Grok Imagine',
  'grok/grok-imagine-image-quality': 'Grok Imagine HD',
  'workbuddy/hunyuan-image-alpha': 'Hunyuan Image',
  'antigravity/gemini-3.1-flash-image': 'Gemini Flash Image',
  'minimax-code/MiniMax-Image': 'MiniMax Image',
  'sensenova-token-plan/sensenova-u1.5-lite': 'SenseNova Image'
}

export function imageModelName(id: string): string {
  return IMAGE_MODEL_NAMES[id] ?? id.split('/').pop() ?? id
}

export function imageRatioLabel(value: string): string {
  return IMAGE_RATIO_OPTIONS.find((option) => option.value === value)?.label ?? (value || 'Auto')
}

export function imageQualityLabel(value: string, t: (key: string) => string): string {
  switch (value) {
    case 'low':
      return t('Low')
    case 'medium':
      return t('Medium')
    case 'high':
      return t('High')
    case 'xhigh':
      return t('Xhigh')
    case 'max':
      return t('Max')
    default:
      return t('Auto')
  }
}
