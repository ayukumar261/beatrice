import type { Tool } from "./index";

export const getTime: Tool = {
  definition: {
    type: "function",
    function: {
      name: "get_time",
      description: "Get the current date and time in a given IANA timezone.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: 'IANA timezone, e.g. "Asia/Tokyo"',
          },
        },
        required: ["timezone"],
      },
    },
  },
  execute: async (args) => {
    const timezone = typeof args.timezone === "string" ? args.timezone : "UTC";
    try {
      return new Date().toLocaleString("en-US", {
        timeZone: timezone,
        dateStyle: "full",
        timeStyle: "long",
      });
    } catch {
      return `Error: unknown timezone "${timezone}".`;
    }
  },
};
