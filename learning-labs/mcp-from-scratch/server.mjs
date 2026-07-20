import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-11-25";

const tools = [
  {
    name: "calendar_reschedule_preview",
    title: "Preview a calendar reschedule",
    description: "Preview a new meeting time without changing a real calendar.",
    inputSchema: {
      type: "object",
      properties: {
        eventTitle: { type: "string", minLength: 1 },
        newStart: {
          type: "string",
          format: "date-time",
          description: "New RFC3339 start time.",
        },
      },
      required: ["eventTitle", "newStart"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        preview: { type: "string" },
        mutated: { type: "boolean" },
      },
      required: ["preview", "mutated"],
      additionalProperties: false,
    },
  },
];

let initialized = false;
let clientReady = false;

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendError(null, -32700, "Parse error");
    return;
  }

  if (message.method === "notifications/initialized" && message.id === undefined) {
    clientReady = true;
    return;
  }

  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize": {
      initialized = true;
      sendResult(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "from-scratch-calendar-lab",
          version: "1.0.0",
        },
      });
      return;
    }

    case "ping": {
      sendResult(message.id, {});
      return;
    }

    case "tools/list": {
      if (!requireReady(message.id)) return;
      sendResult(message.id, { tools });
      return;
    }

    case "tools/call": {
      if (!requireReady(message.id)) return;
      callTool(message.id, message.params);
      return;
    }

    default:
      sendError(message.id, -32601, `Method not found: ${String(message.method)}`);
  }
});

function requireReady(id) {
  if (initialized && clientReady) return true;
  sendError(id, -32002, "Client has not completed MCP initialization");
  return false;
}

function callTool(id, params) {
  if (params?.name !== "calendar_reschedule_preview") {
    sendError(id, -32602, `Unknown tool: ${String(params?.name)}`);
    return;
  }

  const eventTitle = params?.arguments?.eventTitle;
  const newStart = params?.arguments?.newStart;
  if (
    typeof eventTitle !== "string" ||
    eventTitle.length === 0 ||
    typeof newStart !== "string" ||
    Number.isNaN(Date.parse(newStart))
  ) {
    sendResult(id, {
      content: [
        {
          type: "text",
          text: "Invalid input: eventTitle and an RFC3339 newStart are required.",
        },
      ],
      isError: true,
    });
    return;
  }

  const structuredContent = {
    preview: `Would move “${eventTitle}” to ${new Date(newStart).toISOString()}`,
    mutated: false,
  };
  sendResult(id, {
    content: [{ type: "text", text: structuredContent.preview }],
    structuredContent,
    isError: false,
  });
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function send(message) {
  // In stdio MCP, stdout is protocol-only. Logs must go to stderr.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
