import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));
const server = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
});

let nextId = 1;
const pending = new Map();
const lines = createInterface({ input: server.stdout, crlfDelay: Infinity });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  console.log(`SERVER → MCP CLIENT\n${pretty(message)}\n`);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});

server.on("error", (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
});

await request("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "from-scratch-client-lab", version: "1.0.0" },
});
notify("notifications/initialized");

const catalog = await request("tools/list");

console.log("HOST → MODEL (not MCP traffic)");
console.log("The host filters/translates the returned definitions into its model API:");
console.log(pretty(catalog.tools));
console.log();

const modelProposal = {
  name: "calendar_reschedule_preview",
  arguments: {
    eventTitle: "Dentist appointment",
    newStart: "2026-07-24T10:30:00+05:30",
  },
};
console.log("MODEL → HOST (not MCP traffic)");
console.log("The model proposes a provider-format tool call:");
console.log(`${pretty(modelProposal)}\n`);

console.log("HOST POLICY (not MCP traffic)");
console.log("The host would validate, authorize, and optionally ask for approval here.\n");

await request("tools/call", modelProposal);

server.stdin.end();
await new Promise((resolve, reject) => {
  server.once("exit", (code) => {
    if (code === 0) resolve();
    else reject(new Error(`Server exited with code ${String(code)}`));
  });
});

function request(method, params) {
  const id = nextId++;
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params === undefined ? {} : { params }),
  };
  send(message);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method, params) {
  send({
    jsonrpc: "2.0",
    method,
    ...(params === undefined ? {} : { params }),
  });
}

function send(message) {
  console.log(`MCP CLIENT → SERVER\n${pretty(message)}\n`);
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}
