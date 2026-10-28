// The get_dr tool: argument checks, backend choice and the result shape.

import { BackendError, findBinary, isNoResponse, viaApi, viaBinary, type Backend, type DrRecord, type Query } from "./backends.js";
import { HOMEPAGE } from "./version.js";

export const ATTRIBUTION = "Domain Rating by Ahrefs – https://ahrefs.com/";

const DESCRIPTION = "Ahrefs Domain Rating (0–100) for domains or URLs, via getdr by Index Pages";

export function toolDefinition(structured: boolean): unknown {
  const tool: { [k: string]: unknown } = {
    name: "get_dr",
    title: "Ahrefs Domain Rating",
    description: DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "Domains or URLs. URLs are reduced to the host, www. is dropped, duplicates are removed; results follow the input order.",
        },
        version: {
          type: "string",
          enum: ["dr3", "dr4"],
          description: "DR formula: dr3 (default) or dr4 (the new one). Values are not comparable between versions.",
        },
        fresh: {
          type: "boolean",
          description: "Ignore the cache and fetch again.",
        },
      },
      required: ["targets"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  };
  if (structured) {
    tool.outputSchema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              dr: { type: ["number", "null"], description: "null: no data, or no response when checked_at is null" },
              version: { type: "string", enum: ["dr3", "dr4"] },
              checked_at: { type: ["string", "null"], description: "RFC 3339 UTC; null when there was no response" },
              cached: { type: "boolean" },
            },
            required: ["target", "dr", "version", "checked_at", "cached"],
          },
        },
        attribution: { type: "string" },
      },
      required: ["results", "attribution"],
    };
  }
  return tool;
}

export interface CallToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: { results: DrRecord[]; attribution: string };
  isError?: boolean;
}

export interface Options {
  structured: boolean;
  env: NodeJS.ProcessEnv;
}

function toolError(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const NO_BACKEND =
  "getdr is not available. Either set GETDR_API to the URL of a getdr server (getdr serve), " +
  "or install the getdr binary and put it on PATH: go install github.com/index-pages/getdr@latest, " +
  "or download it from https://github.com/index-pages/getdr/releases. " +
  `The binary needs a free Ahrefs API key in AHREFS_KEY; a getdr server brings its own. Setup: ${HOMEPAGE}`;

// Returns the checked arguments or an error message for the model.
function checkArgs(a: { [k: string]: unknown }): Query | string {
  for (const k of Object.keys(a)) {
    if (k !== "targets" && k !== "version" && k !== "fresh") {
      return `unknown argument "${k}"; get_dr takes targets, version and fresh`;
    }
  }
  const { targets, version, fresh } = a;
  if (!Array.isArray(targets) || targets.length === 0) {
    return "targets must be a non-empty array of domains or URLs, e.g. [\"example.com\"]";
  }
  for (const t of targets) {
    if (typeof t !== "string") return "every target must be a string";
    if (/[\r\n]/.test(t)) return "a target must not contain line breaks";
  }
  if (version !== undefined && version !== "dr3" && version !== "dr4") {
    return 'version must be "dr3" or "dr4"';
  }
  if (fresh !== undefined && typeof fresh !== "boolean") {
    return "fresh must be true or false";
  }
  return { targets, version, fresh };
}

export async function callGetDr(raw: { [k: string]: unknown }, opts: Options): Promise<CallToolResult> {
  const args = checkArgs(raw);
  if (typeof args === "string") return toolError(args);

  let backend: Backend;
  const api = opts.env.GETDR_API?.trim();
  if (api) {
    backend = (q) => viaApi(api, opts.env.GETDR_SERVE_TOKEN || undefined, q);
  } else {
    const bin = findBinary(opts.env);
    if (!bin) return toolError(NO_BACKEND);
    backend = (q) => viaBinary(bin, opts.env, q);
  }

  let records: DrRecord[];
  let detail = "";
  try {
    ({ records, detail } = await backend(args));
  } catch (err) {
    if (err instanceof BackendError) return toolError(err.message);
    throw err;
  }

  const missing = records.filter(isNoResponse);
  if (records.length > 0 && missing.length === records.length) {
    return toolError(
      `No response for any target${detail ? `: ${detail}` : " (timeout or rate limit on the Ahrefs side)"}. Try again later.`,
    );
  }

  let text = records.length ? "[\n" + records.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n" : "[]\n";
  if (missing.length > 0) {
    text +=
      `\nNo response for ${missing.length} of ${records.length} target(s), dr and checked_at are null: ` +
      `${missing.map((r) => r.target).join(", ")}. Try these again later.\n`;
  }
  text += `\n${ATTRIBUTION}`;

  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (opts.structured) result.structuredContent = { results: records, attribution: ATTRIBUTION };
  return result;
}
