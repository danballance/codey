import type { ActionMenuDefinition } from "./types";

export const CODE_MENU = {
  label: "Code",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "definition",
          label: "Definition",
          tap: { type: "input", nvimInput: "grd", after: "root" },
        },
        {
          id: "references",
          label: "References",
          tap: { type: "input", nvimInput: "grr", after: "root" },
        },
        {
          id: "implementation",
          label: "Implementation",
          tap: { type: "input", nvimInput: "gri", after: "root" },
        },
        {
          id: "type-definition",
          label: "Type",
          tap: { type: "input", nvimInput: "grt", after: "root" },
        },
        {
          id: "hover",
          label: "Hover",
          tap: { type: "input", nvimInput: "K", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "code-action",
          label: "Code Action",
          tap: { type: "input", nvimInput: "gra", after: "root" },
        },
        {
          id: "rename",
          label: "Rename",
          tap: { type: "input", nvimInput: "grn", after: "root" },
        },
        {
          id: "format",
          label: "Format",
          tap: { type: "input", nvimInput: "<Space>f", after: "root" },
        },
        {
          id: "diagnostic",
          label: "Diagnostic",
          tap: { type: "input", nvimInput: "<C-w>d", after: "root" },
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
