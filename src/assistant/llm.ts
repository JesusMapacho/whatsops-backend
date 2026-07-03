import { initChatModel } from 'langchain/chat_models/universal';
import type { ConfigService } from '@nestjs/config';

// Config del LLM: siempre server-side (env), nunca del prompt ni del cliente.
export interface LlmConfig {
  provider: string; // "openai" (compat: azure/groq/ollama/…), "anthropic", …
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export function readLlmConfig(config: ConfigService): LlmConfig {
  const model = config.get<string>('LLM_MODEL');
  const apiKey = config.get<string>('LLM_API_KEY');
  if (!model || !apiKey) {
    throw new Error('Asistente sin configurar: faltan LLM_MODEL / LLM_API_KEY');
  }
  return {
    provider: config.get<string>('LLM_PROVIDER') ?? 'openai',
    model,
    apiKey,
    baseUrl: config.get<string>('LLM_BASE_URL'),
  };
}

// Footgun documentado: ChatOpenAI recibe la URL como `configuration.baseURL`
// (anidado, URL en mayúsculas); ChatAnthropic (y la mayoría) como `baseUrl` top-level.
export function baseUrlField(provider: string, baseUrl?: string): Record<string, unknown> {
  if (!baseUrl) return {};
  if (provider === 'openai' || provider === 'azure_openai') {
    return { configuration: { baseURL: baseUrl } };
  }
  return { baseUrl };
}

// Modelo provider-agnóstico. `configurableFields` **enumerados** (no "any"): evita que
// un campo configurable (p. ej. baseUrl) sea redirigible en runtime → SSRF/robo de credencial.
// Los defaults vienen de env y nunca se sobreescriben en invoke.
export function buildChatModel(cfg: LlmConfig) {
  return initChatModel(cfg.model, {
    modelProvider: cfg.provider,
    configurableFields: ['model', 'apiKey', 'baseUrl'],
    configPrefix: 'llm',
    apiKey: cfg.apiKey,
    ...baseUrlField(cfg.provider, cfg.baseUrl),
  });
}
