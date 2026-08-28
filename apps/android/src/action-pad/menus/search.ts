import type { ActionMenuDefinition } from "./types";

export const SEARCH_MENU = {
  label: "Search",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "grep",
          label: "Grep (Live)",
          tap: { type: "input", nvimInput: "<Space>sg", after: "root" },
        },
        {
          id: "files",
          label: "Find File",
          tap: { type: "input", nvimInput: "<Space>sf", after: "root" },
        },
        {
          id: "buffer",
          label: "Buffer Search",
          tap: { type: "input", nvimInput: "<Space>/", after: "root" },
        },
        {
          id: "symbols",
          label: "Symbol",
          tap: { type: "input", nvimInput: "gO", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "recent",
          label: "Recent Files",
          tap: { type: "input", nvimInput: "<Space>s.", after: "root" },
        },
        {
          id: "replace",
          label: "Replace",
          tap: { type: "input", nvimInput: ":%s/", after: "root" },
        },
        {
          id: "word",
          label: "Word Under Cursor",
          tap: { type: "input", nvimInput: "<Space>sw", after: "root" },
        },
        {
          id: "diagnostics",
          label: "Diagnostics",
          tap: { type: "input", nvimInput: "<Space>sd", after: "root" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
