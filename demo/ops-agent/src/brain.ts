// the chat shape both brains speak: openai-compatible messages and function tools
export type ToolSpec = {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
};
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export type Turn = { say?: string; calls: ToolCall[] };

export interface Brain {
  next(messages: Message[], tools: ToolSpec[]): Promise<Turn>;
}
