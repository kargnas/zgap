import { MAX_ACCESS_TOKEN_SIZE } from "./constants.mjs";

async function readPipedApiKey(input) {
  let value = "";
  for await (const chunk of input) {
    value += chunk;
    if (value.length > MAX_ACCESS_TOKEN_SIZE + 2) throw new Error("Invalid API key.");
  }
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

export async function readApiKey({ input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return readPipedApiKey(input);

  output.write("API key: ");
  const wasRaw = Boolean(input.isRaw);
  let value = "";
  let onData;
  let onEnd;
  let onError;

  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise((resolve, reject) => {
      onData = (chunk) => {
        for (const character of chunk) {
          if (character === "\u0003") {
            reject(new Error("API key input cancelled."));
            return;
          }
          if (character === "\r" || character === "\n" || character === "\u0004") {
            resolve(value);
            return;
          }
          if (character === "\b" || character === "\u007F") {
            value = value.slice(0, -1);
            continue;
          }
          if (character >= " ") {
            value += character;
            if (value.length > MAX_ACCESS_TOKEN_SIZE) {
              reject(new Error("Invalid API key."));
              return;
            }
          }
        }
      };
      onEnd = () => resolve(value);
      onError = reject;
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
    });
  } finally {
    if (onData) input.off("data", onData);
    if (onEnd) input.off("end", onEnd);
    if (onError) input.off("error", onError);
    if (!wasRaw) input.setRawMode(false);
    input.pause();
    output.write("\n");
  }
}
