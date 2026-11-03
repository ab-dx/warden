import type { Brain, Message, ToolSpec, Turn } from './brain.js';

// any openai-compatible chat endpoint: openrouter, gemini's compatibility api, ollama, vllm
export function llmBrain(opts: {
  baseUrl: string;
  model: string;
  apiKey?: string | undefined;
}): Brain {
  return {
    async next(messages: Message[], tools: ToolSpec[]): Promise<Turn> {
      const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          messages,
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema },
          })),
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!res.ok)
        throw new Error(
          `model endpoint returned ${res.status}: ${(await res.text()).slice(0, 300)}`,
        );
      const body = (await res.json()) as {
        choices: {
          message: {
            content: string | null;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
        }[];
      };
      const m = body.choices[0]?.message;
      return {
        ...(m?.content ? { say: m.content } : {}),
        calls: (m?.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          args: parseArgs(c.function.arguments),
        })),
      };
    },
  };
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
