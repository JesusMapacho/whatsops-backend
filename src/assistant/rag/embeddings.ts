import { OpenAIEmbeddings } from '@langchain/openai';
import type { ConfigService } from '@nestjs/config';

// Embeddings del proveedor configurado server-side. OpenAI-compatible (baseURL) cubre
// OpenAI/Azure/Ollama/etc. La dimensión debe casar con schema_embedding (assistant-setup.sql).
export function buildEmbeddings(config: ConfigService): OpenAIEmbeddings {
  const apiKey = config.get<string>('EMBEDDINGS_API_KEY') ?? config.get<string>('LLM_API_KEY');
  if (!apiKey) throw new Error('Embeddings sin configurar: falta EMBEDDINGS_API_KEY');
  const baseURL = config.get<string>('EMBEDDINGS_BASE_URL');
  return new OpenAIEmbeddings({
    apiKey,
    model: config.get<string>('EMBEDDINGS_MODEL') ?? 'text-embedding-3-small',
    ...(baseURL ? { configuration: { baseURL } } : {}),
  });
}
